import * as fs from 'node:fs';
import * as path from 'node:path';
import * as core from '@actions/core';
import * as yaml from 'js-yaml';
import type { Severity } from './types.js';

export type Mode = 'review' | 'refactor' | 'both';
export type ProviderName = 'anthropic' | 'openai';
/**
 * How much thinking the model should do before answering. `auto` sends nothing
 * and leaves the endpoint's own default in place; every other value is passed
 * through as `reasoning_effort` (and turns Anthropic's adaptive thinking off at
 * `none`). Reasoning tokens are billed against the same output cap as the
 * answer, so a model that thinks at length can truncate its own JSON no matter
 * how small the batch is.
 */
export type Reasoning = 'auto' | 'none' | 'minimal' | 'low' | 'medium' | 'high';

export interface Config {
  provider: ProviderName;
  model: string;
  baseUrl?: string;
  apiKey: string;
  githubToken: string;
  mode: Mode;
  maxComments: number;
  minSeverity: Severity;
  minConfidence: number;
  include: string[];
  exclude: string[];
  guidelines: string;
  failOnSeverity: Severity | 'none';
  /** Fail the check when some of the diff could not be reviewed at all. */
  failOnIncomplete: boolean;
  maxIssues: number;
  issueLabels: string[];
  dryRun: boolean;
  /** Rough character budget per LLM call; ~3.5 chars per token. */
  maxCharsPerBatch: number;
  maxFiles: number;
  reasoning: Reasoning;
  /** Output-token ceiling for one LLM call. Reasoning tokens count against it. */
  maxResponseTokens: number;
  /**
   * Extra top-level fields merged into the OpenAI-compatible request body, for
   * endpoint-specific knobs this action does not model. Config file only: it is
   * a passthrough, so a typo here reaches the server verbatim.
   */
  requestOptions: Record<string, unknown>;
}

const DEFAULT_MODELS: Record<ProviderName, string> = {
  anthropic: 'claude-opus-5',
  openai: 'gpt-4.1',
};

/**
 * Files that are almost never worth spending tokens on. Users add to this list
 * via `exclude`; they do not replace it unless they set `exclude_defaults: false`.
 */
const DEFAULT_EXCLUDES = [
  '**/*.lock',
  '**/package-lock.json',
  '**/pnpm-lock.yaml',
  '**/yarn.lock',
  '**/poetry.lock',
  '**/Cargo.lock',
  '**/go.sum',
  '**/composer.lock',
  '**/Gemfile.lock',
  'dist/**',
  'build/**',
  'out/**',
  'vendor/**',
  'node_modules/**',
  '**/*.min.js',
  '**/*.min.css',
  '**/*.map',
  '**/*.snap',
  '**/__snapshots__/**',
  '**/*.svg',
  '**/*.png',
  '**/*.jpg',
  '**/*.jpeg',
  '**/*.gif',
  '**/*.pdf',
  '**/*.ico',
  '**/*.woff*',
  '**/*.generated.*',
  '**/*_pb2.py',
  '**/*.pb.go',
];

const SEVERITIES: Severity[] = ['low', 'medium', 'high', 'critical'];
const REASONING_LEVELS: Reasoning[] = ['auto', 'none', 'minimal', 'low', 'medium', 'high'];

function splitList(value: string | undefined): string[] {
  if (!value) return [];
  return value
    .split(/[\n,]/)
    .map((s) => s.trim())
    .filter(Boolean);
}

function asStringList(value: unknown): string[] {
  if (Array.isArray(value)) return value.map(String).map((s) => s.trim()).filter(Boolean);
  if (typeof value === 'string') return splitList(value);
  return [];
}

function pickReasoning(value: unknown): Reasoning {
  const v = String(value ?? '').toLowerCase();
  if (!v) return 'auto';
  if ((REASONING_LEVELS as string[]).includes(v)) return v as Reasoning;
  // 'off'/'false'/'disabled' are what people reach for first; accept them.
  if (['off', 'false', 'no', 'disabled'].includes(v)) return 'none';
  core.warning(`Unknown reasoning level "${v}"; leaving the endpoint default in place.`);
  return 'auto';
}

function pickSeverity(value: unknown, fallback: Severity): Severity {
  const v = String(value ?? '').toLowerCase();
  return (SEVERITIES as string[]).includes(v) ? (v as Severity) : fallback;
}

function readFileConfig(configPath: string): Record<string, unknown> {
  const abs = path.resolve(process.env.GITHUB_WORKSPACE ?? process.cwd(), configPath);
  if (!fs.existsSync(abs)) {
    core.debug(`No config file at ${abs}; using inputs and defaults.`);
    return {};
  }
  try {
    const parsed = yaml.load(fs.readFileSync(abs, 'utf8'));
    if (parsed && typeof parsed === 'object') {
      core.info(`Loaded config from ${configPath}`);
      return parsed as Record<string, unknown>;
    }
  } catch (err) {
    core.warning(`Could not parse ${configPath}: ${(err as Error).message}. Falling back to defaults.`);
  }
  return {};
}

/**
 * Precedence: action input (when non-empty) > config file > built-in default.
 * Action inputs default to '' in action.yml precisely so this ordering works.
 */
export function loadConfig(): Config {
  const file = readFileConfig(core.getInput('config-path') || '.github/hawky.yml');
  const input = (name: string) => core.getInput(name).trim();
  const pick = (inputName: string, fileKey: string): string | undefined => {
    const fromInput = input(inputName);
    if (fromInput) return fromInput;
    const fromFile = file[fileKey];
    return fromFile === undefined || fromFile === null ? undefined : String(fromFile);
  };
  const num = (inputName: string, fileKey: string, fallback: number): number => {
    const raw = pick(inputName, fileKey);
    const parsed = raw === undefined ? NaN : Number(raw);
    return Number.isFinite(parsed) ? parsed : fallback;
  };

  const providerRaw = (pick('provider', 'provider') ?? 'anthropic').toLowerCase();
  const provider: ProviderName = providerRaw === 'openai' ? 'openai' : 'anthropic';
  if (providerRaw !== 'openai' && providerRaw !== 'anthropic') {
    core.warning(`Unknown provider "${providerRaw}"; falling back to "anthropic".`);
  }

  const modeRaw = (pick('mode', 'mode') ?? 'review').toLowerCase();
  const mode: Mode = modeRaw === 'refactor' || modeRaw === 'both' ? modeRaw : 'review';

  const excludeDefaults = file.exclude_defaults !== false;
  const exclude = [
    ...(excludeDefaults ? DEFAULT_EXCLUDES : []),
    ...splitList(input('exclude')),
    ...asStringList(file.exclude),
  ];

  const failRaw = (pick('fail-on-severity', 'fail_on_severity') ?? 'none').toLowerCase();

  return {
    provider,
    model: pick('model', 'model') ?? DEFAULT_MODELS[provider],
    baseUrl: pick('base-url', 'base_url'),
    apiKey: core.getInput('api-key', { required: true }),
    githubToken: input('github-token') || process.env.GITHUB_TOKEN || '',
    mode,
    maxComments: num('max-comments', 'max_comments', 15),
    minSeverity: pickSeverity(pick('min-severity', 'min_severity'), 'medium'),
    minConfidence: num('min-confidence', 'min_confidence', 0.6),
    include: [...splitList(input('include')), ...asStringList(file.include)],
    exclude,
    guidelines: pick('guidelines', 'guidelines') ?? '',
    failOnSeverity: (SEVERITIES as string[]).includes(failRaw) ? (failRaw as Severity) : 'none',
    failOnIncomplete:
      (input('fail-on-incomplete') || String(file.fail_on_incomplete ?? 'false')).toLowerCase() === 'true',
    maxIssues: num('max-issues', 'max_issues', 3),
    issueLabels: (() => {
      const l = [...splitList(input('issue-labels')), ...asStringList(file.issue_labels)];
      return l.length ? l : ['hawky', 'refactor'];
    })(),
    dryRun: (input('dry-run') || String(file.dry_run ?? 'false')).toLowerCase() === 'true',
    maxCharsPerBatch: num('', 'max_chars_per_batch', 120_000),
    maxFiles: num('', 'max_files', 60),
    reasoning: pickReasoning(pick('reasoning', 'reasoning')),
    maxResponseTokens: num('max-response-tokens', 'max_response_tokens', 16_000),
    requestOptions:
      file.request_options && typeof file.request_options === 'object' && !Array.isArray(file.request_options)
        ? (file.request_options as Record<string, unknown>)
        : {},
  };
}
