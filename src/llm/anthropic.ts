import Anthropic from '@anthropic-ai/sdk';
import * as core from '@actions/core';
import type { CompleteRequest, CompleteResponse, Provider } from '../types.js';
import { parseJsonObject, schemaInstruction } from './json.js';
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
  private readonly client: Anthropic;
  /** Set once a 400 tells us this model does not accept a knob, so we stop sending it. */
  private supportsThinking = true;
  private supportsSchema = true;

  constructor(
    readonly model: string,
    apiKey: string,
    baseUrl?: string,
  ) {
    this.client = new Anthropic({
      apiKey,
      ...(baseUrl ? { baseURL: baseUrl } : {}),
      maxRetries: 4,
      timeout: 10 * 60 * 1000,
    });
  }

  async complete<T>(req: CompleteRequest): Promise<CompleteResponse<T>> {
    for (;;) {
      try {
        return await this.attempt<T>(req);
      } catch (err) {
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

  private async attempt<T>(req: CompleteRequest): Promise<CompleteResponse<T>> {
    const params: Record<string, unknown> = {
      model: this.model,
      max_tokens: req.maxTokens,
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
    if (res.stop_reason === 'max_tokens') {
      throw new Error(
        `The response hit the ${req.maxTokens}-token cap and was truncated. Lower \`max_chars_per_batch\` so each batch asks for less.`,
      );
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
      },
    };
  }
}
