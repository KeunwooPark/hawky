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
/**
 * How a reviewer may waive a finding so it stops gating the merge. `command` is
 * an `@hawky ignore` reply; `all` also accepts resolving the review thread;
 * `off` makes the gate absolute, with no route past it but changing the code.
 */
export type Dismissals = 'all' | 'command' | 'off';

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
  /** Which reviewer gestures waive a finding for the purposes of the gate. */
  dismissals: Dismissals;
  /**
   * Search the checked-out repository for definitions this change re-implements,
   * and show them to the reviewer. Off when there is no checkout to search, which
   * is warned about rather than failed on.
   */
  codebaseContext: boolean;
  /** Append a collapsed "report a Hawky bug" section to the summary comment. */
  bugReportFooter: boolean;
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
   * Seconds to allow one LLM call before giving up on it. 0 derives the deadline
   * from `maxResponseTokens`, which is what it should be: a budget big enough to
   * outlast a fixed timeout makes every attempt fail on the clock rather than on
   * anything the model did. Set this only for an endpoint slower than the
   * derivation assumes.
   */
  requestTimeoutSeconds: number;
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
const DISMISSAL_MODES: Dismissals[] = ['all', 'command', 'off'];

/**
 * Every key `loadConfig` reads out of the YAML file. A key that is not here was
 * silently ignored before, which is indistinguishable from the feature not
 * working — `fail-on-severity` written in kebab case turned the merge gate off
 * and said nothing.
 */
const KNOWN_FILE_KEYS = [
  'provider',
  'model',
  'base_url',
  'mode',
  'max_comments',
  'min_severity',
  'min_confidence',
  'include',
  'exclude',
  'exclude_defaults',
  'guidelines',
  'fail_on_severity',
  'fail_on_incomplete',
  'dismissals',
  'codebase_context',
  'bug_report_footer',
  'max_issues',
  'issue_labels',
  'dry_run',
  'max_chars_per_batch',
  'max_files',
  'reasoning',
  'max_response_tokens',
  'request_timeout',
  'request_options',
];

function warnUnknownFileKeys(file: Record<string, unknown>, configPath: string): void {
  for (const key of Object.keys(file)) {
    if (KNOWN_FILE_KEYS.includes(key)) continue;
    const snake = key.replace(/-/g, '_');
    if (KNOWN_FILE_KEYS.includes(snake)) {
      core.warning(
        `${configPath}: "${key}" is being ignored — this file uses snake_case. Did you mean "${snake}"?`,
      );
    } else {
      core.warning(`${configPath}: unknown key "${key}" is being ignored.`);
    }
  }
}

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

/**
 * `none` is still honoured — configurations that set it keep working — but it is
 * no longer a level to reach for. Reviewing a diff is the kind of work the
 * thinking is for, and a model told not to think at all comes back in seconds
 * having found nothing: a nineteen-file diff reviewed clean in about five seconds
 * at `none` and properly at `minimal`. A merge gate cannot tell that from a clean
 * diff, so it is a green check on a review that never happened.
 *
 * Warned about rather than quietly raised to `minimal`. Reviewing at a level the
 * caller did not ask for, and billing them for it, is its own surprise; what they
 * are owed here is to be told what the setting costs them.
 */
function warnIfThinkingOff(level: Reasoning): Reasoning {
  if (level === 'none') {
    core.warning(
      'reasoning: none turns the model\'s thinking off entirely. Reviewing a diff is what that thinking ' +
        'is for, and without it a review can finish in seconds having found nothing — which a merge gate ' +
        'cannot tell apart from a clean diff. Use "minimal" as the floor instead.',
    );
  }
  return level;
}

function pickReasoning(value: unknown): Reasoning {
  const v = String(value ?? '').toLowerCase();
  if (!v) return 'auto';
  if ((REASONING_LEVELS as string[]).includes(v)) return warnIfThinkingOff(v as Reasoning);
  // 'off'/'false'/'disabled' are what people reach for first; accept them.
  if (['off', 'false', 'no', 'disabled'].includes(v)) return warnIfThinkingOff('none');
  core.warning(`Unknown reasoning level "${v}"; leaving the endpoint default in place.`);
  return 'auto';
}

/**
 * Unknown values degrade to `off` rather than to the default. This is the one
 * setting whose fallback should be the stricter behaviour: a typo that quietly
 * opened a route past the merge gate is worse than one that leaves it shut and
 * says so.
 */
function pickDismissals(value: string | undefined): Dismissals {
  const v = (value ?? '').toLowerCase();
  if (!v) return 'all';
  if ((DISMISSAL_MODES as string[]).includes(v)) return v as Dismissals;
  if (['true', 'yes', 'on'].includes(v)) return 'all';
  if (['false', 'no', 'none'].includes(v)) return 'off';
  core.warning(
    `Unknown dismissals mode "${v}"; no finding can be waived on this run. Use one of: ${DISMISSAL_MODES.join(' | ')}.`,
  );
  return 'off';
}

function pickSeverity(value: unknown, fallback: Severity, label: string): Severity {
  const v = String(value ?? '').toLowerCase();
  if (!v) return fallback;
  if ((SEVERITIES as string[]).includes(v)) return v as Severity;
  core.warning(`Unknown ${label} "${v}"; falling back to "${fallback}". Use one of: ${SEVERITIES.join(' | ')}.`);
  return fallback;
}

/** Where the job's checkout lives, when there is one. */
export function workspaceRoot(): string {
  return process.env.GITHUB_WORKSPACE ?? process.cwd();
}

/** The config file this run reads, as a repository-relative path. */
export function configFilePath(): string {
  return core.getInput('config-path') || '.github/hawky.yml';
}

/**
 * The token used to read the diff and write comments.
 *
 * Exported because it is needed before the rest of the configuration exists: the
 * config file may have to be fetched from the repository, which takes a client,
 * which takes a token.
 */
export function githubToken(): string {
  return core.getInput('github-token').trim() || process.env.GITHUB_TOKEN || '';
}

/** True when the job has checked the repository out and the config file is in it. */
export function workspaceConfigExists(): boolean {
  return fs.existsSync(path.resolve(workspaceRoot(), configFilePath()));
}

function parseFileConfig(text: string, configPath: string, source: string): Record<string, unknown> {
  try {
    const parsed = yaml.load(text);
    if (parsed && typeof parsed === 'object') {
      core.info(`Loaded config from ${configPath} (${source}).`);
      return parsed as Record<string, unknown>;
    }
  } catch (err) {
    core.warning(`Could not parse ${configPath}: ${(err as Error).message}. Falling back to defaults.`);
  }
  return {};
}

/**
 * The config file's contents, from the checkout or from whatever the caller
 * fetched in its place.
 *
 * A file that was never found used to say so at debug level only, which is
 * invisible in an ordinary run — and the state it was silent about is one a
 * workflow reaches by following the README: no `actions/checkout` step, because
 * none is needed to review a diff, and therefore no file on disk to read. Every
 * setting in it was ignored without a word, which is indistinguishable from the
 * setting not working. One `exclude` glob ignored that way sent a documentation
 * change to the model and posted a finding on it.
 */
function readFileConfig(configPath: string, fetched?: string): Record<string, unknown> {
  if (fetched !== undefined) return parseFileConfig(fetched, configPath, 'fetched from the repository');

  const abs = path.resolve(workspaceRoot(), configPath);
  if (!fs.existsSync(abs)) {
    core.info(`No config file at ${configPath}; using inputs and defaults.`);
    return {};
  }
  return parseFileConfig(fs.readFileSync(abs, 'utf8'), configPath, 'the checkout');
}

/**
 * Precedence: action input (when non-empty) > config file > built-in default.
 * Action inputs default to '' in action.yml precisely so this ordering works.
 *
 * `fetched` is the config file's text when the caller read it from the repository
 * rather than from a checkout; omitted, the checkout is read as before.
 */
export function loadConfig(fetched?: string): Config {
  const configPath = configFilePath();
  const file = readFileConfig(configPath, fetched);
  warnUnknownFileKeys(file, configPath);
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

  // Anything unrecognised here used to become "none", so a typo turned the merge
  // gate off and the run went green with a critical finding on it.
  const failRaw = (pick('fail-on-severity', 'fail_on_severity') ?? '').toLowerCase();
  let failOnSeverity: Severity | 'none' = 'none';
  if ((SEVERITIES as string[]).includes(failRaw)) {
    failOnSeverity = failRaw as Severity;
  } else if (failRaw && failRaw !== 'none') {
    core.warning(
      `Unknown fail-on-severity "${failRaw}"; this run will not gate. Use one of: ${SEVERITIES.join(' | ')} | none.`,
    );
  }

  return {
    provider,
    model: pick('model', 'model') ?? DEFAULT_MODELS[provider],
    baseUrl: pick('base-url', 'base_url'),
    apiKey: core.getInput('api-key', { required: true }),
    githubToken: githubToken(),
    mode,
    maxComments: num('max-comments', 'max_comments', 15),
    minSeverity: pickSeverity(pick('min-severity', 'min_severity'), 'medium', 'min-severity'),
    minConfidence: num('min-confidence', 'min_confidence', 0.6),
    include: [...splitList(input('include')), ...asStringList(file.include)],
    exclude,
    guidelines: pick('guidelines', 'guidelines') ?? '',
    failOnSeverity,
    failOnIncomplete:
      (input('fail-on-incomplete') || String(file.fail_on_incomplete ?? 'false')).toLowerCase() === 'true',
    dismissals: pickDismissals(pick('dismissals', 'dismissals')),
    // On unless switched off by name. The reuse check is the one a diff-only
    // reviewer cannot answer, and a workflow with no checkout still reviews
    // exactly as it did — it is told once that the scan was skipped.
    codebaseContext: !['false', 'no', 'off'].includes(
      (pick('codebase-context', 'codebase_context') ?? 'true').toLowerCase(),
    ),
    // On unless switched off by name: it is how Hawky's own bugs get reported, so
    // a typo should not be what quietly removes it.
    bugReportFooter: !['false', 'no', 'off'].includes(
      (pick('bug-report-footer', 'bug_report_footer') ?? 'true').toLowerCase(),
    ),
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
    requestTimeoutSeconds: (() => {
      const seconds = num('request-timeout', 'request_timeout', 0);
      if (seconds < 0) {
        core.warning(
          `Ignoring request-timeout "${seconds}": it must be a positive number of seconds. ` +
            'Deriving the deadline from max-response-tokens instead.',
        );
        return 0;
      }
      return seconds;
    })(),
    requestOptions:
      file.request_options && typeof file.request_options === 'object' && !Array.isArray(file.request_options)
        ? (file.request_options as Record<string, unknown>)
        : {},
  };
}
