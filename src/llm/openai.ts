import OpenAI from 'openai';
import * as core from '@actions/core';
import type { Config } from '../config.js';
import type { CompleteRequest, CompleteResponse, Provider } from '../types.js';
import { containsReasoning, parseJsonObject, schemaInstruction, stripReasoning } from './json.js';
import {
  CHARS_PER_TOKEN,
  isBudgetOutOfRange,
  OutputBudget,
  type ReasoningEvidence,
  TruncatedError,
} from './budget.js';
import { ReasoningLadder } from './reasoning.js';
import {
  describeMs,
  isLateFailure,
  isTransientStatus,
  requestTimeoutMs,
  retryAfterMs,
  sleep,
  TransientRetries,
} from './timeout.js';
import { assertMatchesSchema, SchemaViolationError } from './validate.js';

type Variant = 'json_schema' | 'json_object' | 'plain';

/**
 * Reasoning models return two things in one response: the chain of thought and
 * the answer. Both are billed against the same output cap, and depending on the
 * server the thinking arrives either in a `reasoning_content` field or inline in
 * `content` wrapped in `<think>` tags. Either way it is not the answer, so it is
 * dropped before parsing — and when it is what ate the cap, asking for less code
 * per batch cannot help, because the thinking scales with the question, not the
 * answer.
 */
export function readMessage(message: Record<string, unknown> | undefined): {
  content: string;
  reasoning: string;
  hasAnswer: boolean;
} {
  const content = typeof message?.content === 'string' ? message.content : '';
  // Servers disagree on the field name; OpenRouter uses `reasoning`, most
  // vLLM/SGLang-derived ones (Fireworks, Together, DeepSeek) use `reasoning_content`.
  const separate = [message?.reasoning_content, message?.reasoning].find((v) => typeof v === 'string' && v.trim());
  return {
    content,
    reasoning: (separate as string | undefined) ?? (containsReasoning(content) ? content : ''),
    // Whether anything is left once the thinking is taken out. The parser does
    // its own stripping; this only decides which error the user gets to read.
    hasAnswer: stripReasoning(content).trim().length > 0,
  };
}

/**
 * "OpenAI-compatible" covers a wide range of servers — Azure, OpenRouter,
 * Together, Fireworks, Groq, vLLM, llama.cpp, Ollama — and they implement
 * different subsets of the API. Rather than making the user declare what their
 * endpoint supports, we start with the strictest request and step down one
 * capability at a time whenever the server answers 4xx. The working combination
 * is remembered for the rest of the run.
 */
export class OpenAIProvider implements Provider {
  readonly name = 'openai';
  readonly model: string;
  private readonly client: OpenAI;
  private readonly requestOptions: Record<string, unknown>;
  private readonly budget: OutputBudget;
  private variant: Variant = 'json_schema';
  private useLegacyMaxTokens = false;
  /** Which `reasoning_effort` to ask for, and where to go when one is refused. */
  private readonly reasoning: ReasoningLadder;
  /** Seconds the user pinned the deadline to, or 0 to derive it from the budget. */
  private readonly timeoutOverrideSeconds: number;
  private callCount = 0;
  /** The deadline the last attempt was given, so a message can name it. */
  private lastTimeoutMs: number;

  constructor(cfg: Config) {
    this.model = cfg.model;
    this.requestOptions = cfg.requestOptions;
    this.budget = new OutputBudget(cfg.maxResponseTokens);
    this.reasoning = new ReasoningLadder(cfg.reasoning);
    this.timeoutOverrideSeconds = cfg.requestTimeoutSeconds;
    this.lastTimeoutMs = requestTimeoutMs(cfg.maxResponseTokens, cfg.requestTimeoutSeconds);
    this.client = new OpenAI({
      apiKey: cfg.apiKey,
      ...(cfg.baseUrl ? { baseURL: cfg.baseUrl } : {}),
      // Retrying is this class's job now. The SDK cannot be told to repeat a 429
      // but not a timeout, and repeating a timeout unchanged is what turned one
      // ten-minute wall into fifty minutes and `0 tokens`. What it did usefully
      // — backing off a busy server — is done explicitly in `complete`.
      maxRetries: 0,
      // A default for anything that does not pass its own; every call below does.
      timeout: this.lastTimeoutMs,
    });
  }

  get calls(): number {
    return this.callCount;
  }

  async complete<T>(req: CompleteRequest): Promise<CompleteResponse<T>> {
    const retries = new TransientRetries();
    for (;;) {
      const startedAt = Date.now();
      try {
        return await this.attempt<T>(req);
      } catch (err) {
        const elapsed = Date.now() - startedAt;
        // A busy, rate-limited or briefly broken server answers in seconds and is
        // worth the same request again. A 5xx that arrives most of the way through
        // the deadline is not the same thing: a gateway closing every connection at
        // a fixed limit is saying the generation does not fit inside its wall
        // clock, and the identical request does not fit either. So it takes the
        // deadline's remedy below — generate less — rather than three more attempts
        // at fifteen minutes apiece, with a one-second backoff between them.
        const outOfClock =
          err instanceof OpenAI.APIConnectionTimeoutError ||
          (err instanceof OpenAI.APIError &&
            isTransientStatus(err.status) &&
            isLateFailure(elapsed, this.lastTimeoutMs));

        if (err instanceof OpenAI.APIError && isTransientStatus(err.status) && !outOfClock) {
          const wait = retries.next(retryAfterMs(err.headers));
          if (wait !== null) {
            core.warning(
              `${this.model} answered ${err.status} after ${describeMs(elapsed)}; ` +
                `retrying in ${describeMs(wait)} (retry ${retries.attempts}).`,
            );
            await sleep(wait);
            continue;
          }
        }
        const next =
          err instanceof TruncatedError
            ? this.degradeAfterTruncation(err)
            : err instanceof SchemaViolationError
              ? this.degradeAfterViolation(err)
              : this.degrade(err, outOfClock, elapsed);
        if (!next) throw this.giveUp(err, elapsed);
        core.warning(next);
      }
    }
  }

  /**
   * The error to fail the batch with once nothing is left to try. Both kinds of
   * exhaustion get a sentence naming the wall that was hit and the knob that
   * moves it; everything else is the endpoint's own error, unedited.
   */
  private giveUp(err: unknown, elapsedMs: number): unknown {
    if (err instanceof TruncatedError) return new Error(this.truncationAdvice(err));
    if (err instanceof OpenAI.APIConnectionTimeoutError) return new Error(this.timeoutAdvice());
    if (
      err instanceof OpenAI.APIError &&
      isTransientStatus(err.status) &&
      isLateFailure(elapsedMs, this.lastTimeoutMs)
    ) {
      return new Error(this.deadlineAdvice(err.status, elapsedMs));
    }
    return err;
  }

  /**
   * What to tell the user when a 5xx was a deadline and there is nothing left to
   * turn down.
   *
   * Deliberately not `timeoutAdvice`: that one points at `request_timeout`, and
   * the deadline this crossed is not ours to set. Naming the elapsed time is most
   * of the diagnosis — "answered 504" reads like a blip, "answered 504 after
   * 15m01s" is the whole finding.
   */
  private deadlineAdvice(status: number | undefined, elapsedMs: number): string {
    return (
      `${this.model} answered ${status} after ${describeMs(elapsedMs)}, with nothing left to turn down. ` +
      'A 5xx arriving that deep into its own deadline is a fixed limit somewhere on the path — usually a ' +
      'proxy that closes the connection after a set number of minutes — rather than a busy server, so the ' +
      'identical request would cross it again. Lower `max_response_tokens` so there is less to generate, or ' +
      'turn `reasoning` down. It was not retried unchanged: repeating a request that cannot fit inside that ' +
      'limit only spends the same wall clock again.'
    );
  }

  /**
   * What to tell the user when the request ran out of clock rather than budget.
   *
   * "Request timed out." on its own sent people to `max-response-tokens`, which
   * is the one change that makes this worse: a bigger budget is more to
   * generate. The deadline now moves with the budget, so what is left to say is
   * which of the two to change, and that the wait was not silently repeated.
   */
  private timeoutAdvice(): string {
    return (
      `${this.model} did not answer within ${describeMs(this.lastTimeoutMs)}, with nothing left to turn down. ` +
      'That deadline is derived from `max_response_tokens`, so raising the budget already buys a longer wait — ' +
      'if this endpoint is simply slow, set `request_timeout` (in seconds) to override it. Otherwise lower ' +
      '`max_response_tokens` so there is less to generate, or turn `reasoning` down. The request was not ' +
      'retried unchanged: repeating a timeout only spends the same wall clock again.'
    );
  }

  /**
   * The answer was cut off. Free up room for it in the cheapest order: turn the
   * thinking down if that is where the budget went, and otherwise buy more
   * budget. Shrinking the batch is not on this list — the thinking scales with
   * the question, not the answer, so the same question asked about less code
   * gets the same long deliberation.
   *
   * When the thinking is provably almost all of what the budget bought and there
   * is no rung left to turn down to, this gives up instead of raising. The extra
   * room would go to more deliberation rather than to the JSON, and doubling
   * twice more from there is how a batch reaches the request timeout half an
   * hour later with nothing to show for it.
   */
  private degradeAfterTruncation(err: TruncatedError): string | null {
    if (err.evidence !== 'none') {
      const next = this.reasoning.turnDown();
      if (next !== null) {
        const spent = err.reasoningTokens
          ? `${err.reasoningTokens.toLocaleString()} of them on reasoning`
          : 'most of it on reasoning';
        return `${this.model} used its whole ${err.cap}-token output budget, ${spent}, and never finished the JSON. Retrying with reasoning_effort: ${next}.`;
      }
      if (err.reasoningDominated) return null;
    }
    const raised = this.budget.raise();
    if (raised !== null) {
      return `${this.model} still did not finish the JSON within ${err.cap} tokens. Retrying with a ${raised.toLocaleString()}-token budget.`;
    }
    return null;
  }

  /**
   * What to tell the user when the reply was cut off and there is nothing left
   * to try. Shrinking the batch is the right advice only when the answer itself
   * was too long; when the thinking ate the budget it is what sent this user
   * down a fruitless 120k -> 8k chase in the first place.
   */
  private truncationAdvice(err: TruncatedError): string {
    const cap = err.cap.toLocaleString();
    // Name the wall we actually hit, so the next thing the user tries is the
    // thing that can move it.
    const wall = this.budget.capped
      ? `${cap} output tokens, the most ${this.model} will accept`
      : this.budget.raised
        ? `${cap} output tokens, raised from ${this.budget.start.toLocaleString()}`
        : `${cap} output tokens`;

    if (err.evidence === 'none') {
      // A genuinely long answer: less to report on, or more room to report it.
      return (
        `The review was still unfinished within ${wall}, with nothing left to try. ` +
        (this.budget.capped
          ? 'Lower `max_chars_per_batch` so each batch has less to report on, or use a model with a longer output limit.'
          : 'Raise `max_response_tokens`, or lower `max_chars_per_batch` so each batch has less to report on.')
      );
    }

    const spent =
      err.evidence === 'counted'
        ? `spent ${err.reasoningTokens.toLocaleString()} of them on reasoning`
        : err.evidence === 'returned'
          ? 'spent most of them on reasoning'
          : 'spent them on something it did not return, almost certainly reasoning';

    // Name the effort it was still doing this at, so the next thing the reader
    // tries is not the knob that has already been turned as far as it goes.
    const evenAt = !this.reasoning.moved
      ? ''
      : this.reasoning.effort !== null
        ? `, even at reasoning_effort: ${this.reasoning.effort}`
        : ', even with reasoning_effort dropped';

    // Batch size is deliberately not offered here: the thinking scales with the
    // question, not the answer, so a smaller batch buys nothing.
    return (
      `${this.model} never finished the JSON answer within ${wall}, and ${spent}` +
      evenAt +
      '. Reasoning shares the output budget with the answer, so a smaller `max_chars_per_batch` will not help. ' +
      'Turn thinking off with the knob this endpoint documents (via `request_options`, e.g. ' +
      '`chat_template_kwargs: { thinking: false }`)' +
      // A raise is not offered when the thinking is what filled the budget: more
      // room buys more of it, which is the chase this advice exists to end.
      (this.budget.capped || err.reasoningDominated
        ? ', or switch to a model that does not reason.'
        : ', or raise `max_response_tokens` further.')
    );
  }

  /**
   * The server accepted a request carrying the schema and then answered with
   * something that does not satisfy it, so it is not enforcing the schema at
   * all. Step down exactly as if it had rejected the request, which at least
   * puts the schema somewhere the model itself can read it.
   */
  private degradeAfterViolation(err: SchemaViolationError): string | null {
    const why = `${err.violations[0]}${err.violations.length > 1 ? ` (+${err.violations.length - 1} more)` : ''}`;
    if (this.variant === 'json_schema') {
      this.variant = 'json_object';
      return `${this.model} accepted a json_schema request but did not honour it: ${why}. Retrying with JSON mode and the schema in the prompt.`;
    }
    if (this.variant === 'json_object') {
      this.variant = 'plain';
      return `${this.model} returned JSON that does not match the schema: ${why}. Retrying with a prompted JSON instruction.`;
    }
    // Out of variants to try: fail the batch with a message naming the field.
    return null;
  }

  /** Returns a log line when it changed something to retry, or null to give up. */
  private degrade(err: unknown, outOfClock: boolean, elapsedMs: number): string | null {
    // Out of clock rather than out of budget, whether that arrived as a timeout
    // with no status at all or as a 504 from a gateway that had held the
    // connection to its own limit. Either way the model could not deliver this
    // budget inside the deadline it had, and the thinking is the part worth
    // cutting: it is most of what a reasoning model generates, and unlike the
    // answer it is not what we asked for.
    if (outOfClock) {
      const next = this.reasoning.turnDown();
      if (next === null) return null;
      const what =
        err instanceof OpenAI.APIError && err.status !== undefined
          ? `answered ${err.status} after ${describeMs(elapsedMs)}`
          : `did not answer within ${describeMs(elapsedMs)}`;
      return `${this.model} ${what}. Retrying with reasoning_effort: ${next} — less to generate inside the same deadline.`;
    }
    if (!(err instanceof OpenAI.APIError) || err.status === undefined || err.status >= 500) {
      return null;
    }
    const message = String(err.message).toLowerCase();

    // Checked before the legacy-name fallback: "max_completion_tokens must be at
    // most N" is the model's hard ceiling, not a complaint about the field name,
    // and switching names would retry the same too-large value under a new label.
    if (isBudgetOutOfRange(message)) {
      const lowered = this.budget.lower();
      if (lowered === null) return null;
      return `${this.model} will not accept an output budget this large; retrying with ${lowered.toLocaleString()} tokens.`;
    }
    if (!this.useLegacyMaxTokens && message.includes('max_completion_tokens')) {
      this.useLegacyMaxTokens = true;
      return `${this.model} does not accept max_completion_tokens; retrying with max_tokens.`;
    }
    if (this.reasoning.effort !== null && message.includes('reasoning_effort')) {
      const asked = this.reasoning.effort;
      const next = this.reasoning.reject();
      if (next !== null) {
        return `${this.model} does not accept reasoning_effort: ${asked}; retrying with reasoning_effort: ${next}.`;
      }
      return (
        `${this.model} accepts none of the reasoning_effort values left to try; retrying without it. ` +
        'It will now reason at whatever its default is, which is more than you asked for rather than less — ' +
        'turn it off with the knob your endpoint documents, via `request_options`.'
      );
    }
    if (this.variant === 'json_schema' && (message.includes('response_format') || message.includes('json_schema') || message.includes('schema'))) {
      this.variant = 'json_object';
      return `${this.model} does not support json_schema response format; retrying with JSON mode.`;
    }
    if (this.variant === 'json_object' && message.includes('response_format')) {
      this.variant = 'plain';
      return `${this.model} does not support response_format; retrying with a prompted JSON instruction.`;
    }
    return null;
  }

  private async attempt<T>(req: CompleteRequest): Promise<CompleteResponse<T>> {
    const needsPromptedSchema = this.variant !== 'json_schema';
    const user = needsPromptedSchema ? req.user + schemaInstruction(req.schema) : req.user;

    const params: Record<string, unknown> = {
      model: this.model,
      messages: [
        { role: 'system', content: req.system },
        { role: 'user', content: user },
      ],
      [this.useLegacyMaxTokens ? 'max_tokens' : 'max_completion_tokens']: this.budget.tokens,
    };

    if (this.variant === 'json_schema') {
      params.response_format = {
        type: 'json_schema',
        json_schema: { name: req.schemaName, strict: true, schema: req.schema },
      };
    } else if (this.variant === 'json_object') {
      params.response_format = { type: 'json_object' };
    }

    const effort = this.reasoning.effort;
    if (effort !== null) {
      params.reasoning_effort = effort;
    }
    // Last, so an endpoint-specific override wins over what we chose above.
    Object.assign(params, this.requestOptions);

    // Per request rather than per client: the budget is raised mid-run after a
    // truncated reply, and a deadline fixed at construction would not follow it.
    this.lastTimeoutMs = requestTimeoutMs(this.budget.tokens, this.timeoutOverrideSeconds);
    this.callCount++;
    const res = await this.client.chat.completions.create(
      params as unknown as OpenAI.Chat.ChatCompletionCreateParamsNonStreaming,
      { timeout: this.lastTimeoutMs },
    );

    const choice = res.choices[0];
    const { content, reasoning, hasAnswer } = readMessage(
      choice?.message as unknown as Record<string, unknown> | undefined,
    );
    const reasoningTokens = res.usage?.completion_tokens_details?.reasoning_tokens ?? 0;

    if (choice?.finish_reason === 'length') {
      // An endpoint that neither counts reasoning tokens nor returns the thinking
      // still leaves a trace: the budget is gone and hardly any answer arrived.
      const evidence: ReasoningEvidence =
        reasoningTokens > 0
          ? 'counted'
          : reasoning
            ? 'returned'
            : content.length < this.budget.tokens * CHARS_PER_TOKEN * 0.5
              ? 'inferred'
              : 'none';
      throw new TruncatedError(this.budget.tokens, reasoningTokens, evidence);
    }
    if (choice?.message.refusal) {
      throw new Error(`The model refused to review this diff: ${choice.message.refusal}`);
    }
    // A reply that is nothing but thinking is not an answer, and the parser's
    // error would blame the JSON rather than name the cause.
    if (!hasAnswer && reasoning) {
      throw new Error(
        `${this.model} returned only reasoning and no answer. Set \`reasoning\` in .github/hawky.yml to the ` +
          'lowest level this endpoint implements (`minimal`, or `low` where there is no `minimal`) and raise ' +
          '`max-response-tokens`, or disable thinking with the knob your endpoint documents, via ' +
          '`request_options`.',
      );
    }

    const data = parseJsonObject<T>(content);
    assertMatchesSchema(data, req.schema);
    return {
      data,
      usage: {
        inputTokens: res.usage?.prompt_tokens ?? 0,
        outputTokens: res.usage?.completion_tokens ?? 0,
        cachedInputTokens: res.usage?.prompt_tokens_details?.cached_tokens ?? 0,
        reasoningTokens,
      },
    };
  }
}
