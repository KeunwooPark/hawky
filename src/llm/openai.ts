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

  constructor(cfg: Config) {
    this.model = cfg.model;
    this.requestOptions = cfg.requestOptions;
    this.budget = new OutputBudget(cfg.maxResponseTokens);
    this.reasoning = new ReasoningLadder(cfg.reasoning);
    this.client = new OpenAI({
      apiKey: cfg.apiKey,
      ...(cfg.baseUrl ? { baseURL: cfg.baseUrl } : {}),
      maxRetries: 4,
      timeout: 10 * 60 * 1000,
    });
  }

  async complete<T>(req: CompleteRequest): Promise<CompleteResponse<T>> {
    for (;;) {
      try {
        return await this.attempt<T>(req);
      } catch (err) {
        const next =
          err instanceof TruncatedError
            ? this.degradeAfterTruncation(err)
            : err instanceof SchemaViolationError
              ? this.degradeAfterViolation(err)
              : this.degrade(err);
        if (!next) throw err instanceof TruncatedError ? new Error(this.truncationAdvice(err)) : err;
        core.warning(next);
      }
    }
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
  private degrade(err: unknown): string | null {
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

    const res = await this.client.chat.completions.create(
      params as unknown as OpenAI.Chat.ChatCompletionCreateParamsNonStreaming,
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
        `${this.model} returned only reasoning and no answer. Set \`reasoning: minimal\` in .github/hawky.yml ` +
          'and raise `max-response-tokens`, or disable thinking with the knob your endpoint documents, via ' +
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
