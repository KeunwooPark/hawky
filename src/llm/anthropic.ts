import Anthropic from '@anthropic-ai/sdk';
import * as core from '@actions/core';
import type { Config } from '../config.js';
import type { CompleteRequest, CompleteResponse, Provider } from '../types.js';
import { parseJsonObject, schemaInstruction } from './json.js';
import { isBudgetOutOfRange, OutputBudget, TruncatedError } from './budget.js';
import { assertMatchesSchema, SchemaViolationError } from './validate.js';

function isBadRequestAbout(err: unknown, needle: string): boolean {
  return (
    err instanceof Anthropic.APIError &&
    err.status === 400 &&
    String(err.message).toLowerCase().includes(needle)
  );
}

export class AnthropicProvider implements Provider {
  readonly name = 'anthropic';
  readonly model: string;
  private readonly client: Anthropic;
  private readonly budget: OutputBudget;
  /** Set once a 400 tells us this model does not accept a knob, so we stop sending it. */
  private supportsThinking: boolean;
  private supportsSchema = true;

  constructor(cfg: Config) {
    this.model = cfg.model;
    this.budget = new OutputBudget(cfg.maxResponseTokens);
    // Extended thinking is billed against `max_tokens` alongside the answer, so
    // `reasoning: none` turns it off rather than merely asking for less of it.
    this.supportsThinking = cfg.reasoning !== 'none';
    this.client = new Anthropic({
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
        // A cut-off answer is recoverable: stop the model thinking if that is
        // where `max_tokens` went, and otherwise just buy more of it.
        if (err instanceof TruncatedError) {
          const next = this.degradeAfterTruncation(err);
          if (next) {
            core.warning(next);
            continue;
          }
          throw new Error(this.truncationAdvice(err));
        }
        // The model's hard ceiling, discovered by asking past it. Fall back to a
        // value it will take rather than failing the batch.
        if (err instanceof Anthropic.APIError && err.status === 400 && isBudgetOutOfRange(String(err.message).toLowerCase())) {
          const lowered = this.budget.lower();
          if (lowered !== null) {
            core.warning(`${this.model} will not accept an output budget this large; retrying with ${lowered.toLocaleString()} tokens.`);
            continue;
          }
          throw err;
        }
        // Adaptive thinking and structured outputs are unavailable on older
        // Claude models. Drop them and retry rather than failing the run.
        if (this.supportsThinking && isBadRequestAbout(err, 'thinking')) {
          core.warning(`${this.model} rejected adaptive thinking; retrying without it.`);
          this.supportsThinking = false;
          continue;
        }
        if (this.supportsSchema && (isBadRequestAbout(err, 'output_config') || isBadRequestAbout(err, 'json_schema'))) {
          core.warning(`${this.model} rejected structured outputs; falling back to prompted JSON.`);
          this.supportsSchema = false;
          continue;
        }
        // The endpoint took the schema and then ignored it, so stop relying on
        // it and put the schema in the prompt instead.
        if (this.supportsSchema && err instanceof SchemaViolationError) {
          core.warning(
            `${this.model} accepted a structured-output request but did not honour it: ${err.violations[0]}. ` +
              'Falling back to prompted JSON.',
          );
          this.supportsSchema = false;
          continue;
        }
        throw err;
      }
    }
  }

  private degradeAfterTruncation(err: TruncatedError): string | null {
    if (err.evidence !== 'none' && this.supportsThinking) {
      this.supportsThinking = false;
      return `${this.model} spent its whole ${err.cap}-token output budget thinking and never finished the JSON. Retrying without extended thinking.`;
    }
    const raised = this.budget.raise();
    if (raised !== null) {
      return `${this.model} still did not finish the JSON within ${err.cap} tokens. Retrying with a ${raised.toLocaleString()}-token budget.`;
    }
    return null;
  }

  private truncationAdvice(err: TruncatedError): string {
    const tried = this.budget.capped
      ? ` — the most ${this.model} will accept`
      : this.budget.raised
        ? ` (raised from ${this.budget.start.toLocaleString()})`
        : '';
    const moreRoom = this.budget.capped
      ? 'lower `max_chars_per_batch` so each batch has less to report on, or use a model with a longer output limit'
      : 'raise `max_response_tokens`, or lower `max_chars_per_batch` so each batch has less to report on';
    return (
      `The answer was still unfinished at ${err.cap.toLocaleString()} output tokens${tried}` +
      (err.evidence !== 'none' ? ', even with extended thinking off' : '') +
      `. ${moreRoom[0].toUpperCase()}${moreRoom.slice(1)}.`
    );
  }

  private async attempt<T>(req: CompleteRequest): Promise<CompleteResponse<T>> {
    const params: Record<string, unknown> = {
      model: this.model,
      max_tokens: this.budget.tokens,
      // A single cache breakpoint on the system prompt: it is byte-identical
      // across every batch in a run, so batches 2..n read it at cache rates.
      system: req.cacheSystem
        ? [{ type: 'text', text: req.system, cache_control: { type: 'ephemeral' } }]
        : req.system,
      messages: [{ role: 'user', content: req.user }],
    };
    if (this.supportsThinking) {
      params.thinking = { type: 'adaptive' };
    }
    if (this.supportsSchema) {
      params.output_config = { format: { type: 'json_schema', schema: req.schema } };
    } else {
      params.messages = [{ role: 'user', content: req.user + schemaInstruction(req.schema) }];
    }

    const res = (await this.client.messages.create(
      params as unknown as Anthropic.MessageCreateParamsNonStreaming,
    )) as Anthropic.Message;

    if (res.stop_reason === 'refusal') {
      throw new Error(
        'The model declined to review this diff (stop_reason: refusal). This usually means the diff tripped a safety classifier; narrow the reviewed paths with `exclude` or switch models.',
      );
    }
    // Thinking is billed against the same `max_tokens` as the answer, so when it
    // is what filled the budget, a smaller batch does not help. The API does not
    // break thinking out of `output_tokens`, so all we can tell is whether the
    // model thought at all, which is enough to give the right advice.
    const thought = res.content.some((b) => b.type === 'thinking' || b.type === 'redacted_thinking');

    if (res.stop_reason === 'max_tokens') {
      throw new TruncatedError(this.budget.tokens, 0, thought ? 'returned' : 'none');
    }

    const text = res.content
      .filter((b): b is Anthropic.TextBlock => b.type === 'text')
      .map((b) => b.text)
      .join('');

    const data = parseJsonObject<T>(text);
    assertMatchesSchema(data, req.schema);

    const usage = res.usage as Anthropic.Usage & { cache_read_input_tokens?: number | null };
    return {
      data,
      usage: {
        inputTokens: usage.input_tokens ?? 0,
        outputTokens: usage.output_tokens ?? 0,
        cachedInputTokens: usage.cache_read_input_tokens ?? 0,
        // Anthropic bills thinking inside `output_tokens` without breaking it out.
        reasoningTokens: 0,
      },
    };
  }
}
