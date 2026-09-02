import type { Config } from '../config.js';
import type { Provider } from '../types.js';
import { AnthropicProvider } from './anthropic.js';
import { OpenAIProvider } from './openai.js';

export function makeProvider(cfg: Config): Provider {
  return cfg.provider === 'openai' ? new OpenAIProvider(cfg) : new AnthropicProvider(cfg);
}
