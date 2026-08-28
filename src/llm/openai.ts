import OpenAI from 'openai';
import * as core from '@actions/core';
import type { CompleteRequest, CompleteResponse, Provider } from '../types.js';
import { parseJsonObject, schemaInstruction } from './json.js';

type Variant = 'json_schema' | 'json_object' | 'plain';

/**
 * "OpenAI-compatible" covers a wide range of servers — Azure, OpenRouter,
 * Together, Groq, vLLM, llama.cpp, Ollama — and they implement different subsets
 * of the API. Rather than making the user declare what their endpoint supports,
 * we start with the strictest request and step down one capability at a time
 * whenever the server answers 4xx. The working combination is remembered for the
 * rest of the run.
 */
export class OpenAIProvider implements Provider {
  readonly name = 'openai';
  private readonly client: OpenAI;
  private variant: Variant = 'json_schema';
  private useLegacyMaxTokens = false;

  constructor(
    readonly model: string,
    apiKey: string,
    baseUrl?: string,
  ) {
    this.client = new OpenAI({
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
        const next = this.degrade(err);
        if (!next) throw err;
        core.warning(next);
      }
    }
  }

  /** Returns a log line when it changed something to retry, or null to give up. */
  private degrade(err: unknown): string | null {
    if (!(err instanceof OpenAI.APIError) || err.status === undefined || err.status >= 500) {
      return null;
    }
    const message = String(err.message).toLowerCase();

    if (!this.useLegacyMaxTokens && message.includes('max_completion_tokens')) {
      this.useLegacyMaxTokens = true;
      return `${this.model} does not accept max_completion_tokens; retrying with max_tokens.`;
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
      [this.useLegacyMaxTokens ? 'max_tokens' : 'max_completion_tokens']: req.maxTokens,
    };

    if (this.variant === 'json_schema') {
      params.response_format = {
        type: 'json_schema',
        json_schema: { name: req.schemaName, strict: true, schema: req.schema },
      };
    } else if (this.variant === 'json_object') {
      params.response_format = { type: 'json_object' };
    }

    const res = await this.client.chat.completions.create(
      params as unknown as OpenAI.Chat.ChatCompletionCreateParamsNonStreaming,
    );

    const choice = res.choices[0];
    if (choice?.finish_reason === 'length') {
      throw new Error(
        `The response hit the ${req.maxTokens}-token cap and was truncated. Lower \`max_chars_per_batch\` so each batch asks for less.`,
      );
    }
    if (choice?.message.refusal) {
      throw new Error(`The model refused to review this diff: ${choice.message.refusal}`);
    }

    const text = choice?.message.content ?? '';
    return {
      data: parseJsonObject<T>(text),
      usage: {
        inputTokens: res.usage?.prompt_tokens ?? 0,
        outputTokens: res.usage?.completion_tokens ?? 0,
        cachedInputTokens: res.usage?.prompt_tokens_details?.cached_tokens ?? 0,
      },
    };
  }
}
