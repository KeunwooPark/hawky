export type Severity = 'low' | 'medium' | 'high' | 'critical';
export type Effort = 'S' | 'M' | 'L';

export const SEVERITY_ORDER: Record<Severity, number> = {
  low: 0,
  medium: 1,
  high: 2,
  critical: 3,
};

/** One inline comment the model wants to leave on a changed line. */
export interface Finding {
  path: string;
  line: number;
  end_line?: number | null;
  severity: Severity;
  confidence: number;
  category: string;
  title: string;
  body: string;
  /** Replacement source for lines [line, end_line], rendered as a GitHub suggestion block. */
  suggestion?: string | null;
}

/** A repo-level refactoring opportunity, posted as an issue rather than a comment. */
export interface Refactor {
  title: string;
  rationale: string;
  files: string[];
  effort: Effort;
  body: string;
}

export interface ModelResult {
  summary: string;
  findings: Finding[];
  refactors: Refactor[];
}

export interface Usage {
  inputTokens: number;
  outputTokens: number;
  cachedInputTokens: number;
  /** Part of `outputTokens` the model spent thinking before it answered. */
  reasoningTokens: number;
}

export interface CompleteRequest {
  system: string;
  user: string;
  /** JSON Schema the response must conform to. */
  schema: Record<string, unknown>;
  schemaName: string;
  /** True when `system` is byte-identical across calls and worth caching. */
  cacheSystem: boolean;
}

export interface CompleteResponse<T> {
  data: T;
  usage: Usage;
}

export interface Provider {
  readonly name: string;
  readonly model: string;
  /**
   * Requests actually sent, retries included.
   *
   * Reported instead of the batch count, which is what the usage line used to
   * print: five billed attempts behind one batch logged as `1 call(s)`, and a
   * batch that timed out and silently retried four times looked identical to one
   * that answered first time.
   */
  readonly calls: number;
  complete<T>(req: CompleteRequest): Promise<CompleteResponse<T>>;
}

/**
 * The reviewable diff, plus what was left out of it.
 *
 * The omissions travel with the files because the model has to be told about
 * them: a definition in a file that was excluded, was too large to render, or did
 * not survive `max_files` is invisible, and a reviewer who cannot see it reports
 * the symbol as undefined rather than as unshown.
 */
export interface Diff {
  files: DiffFile[];
  /** Paths this change touched that are not in `files`. */
  omitted: string[];
}

/** A file in the diff, reduced to what the reviewer needs. */
export interface DiffFile {
  path: string;
  previousPath?: string;
  status: string;
  additions: number;
  deletions: number;
  patch: string;
  /** Line numbers in the head revision that a RIGHT-side review comment may anchor to. */
  commentableLines: Set<number>;
  /** The patch re-rendered with head line numbers so the model can anchor precisely. */
  annotated: string;
}
