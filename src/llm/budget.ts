/**
 * The output cap is a guillotine, not a target: the model emits thinking first
 * and the answer after it, and when the counter runs out generation stops
 * mid-token — no closing brace, nothing parseable. Since you are billed for the
 * tokens actually generated and not for the ceiling you asked for, the right
 * response to a cut-off reply is to ask for more room and try again.
 *
 * The budget is provider state rather than a per-call argument: a raise earned
 * by one batch carries to the next, so a run does not rediscover the same
 * ceiling once per file.
 */
export class OutputBudget {
  private current: number;
  /** Set once the endpoint refuses a value, which is the model's own hard limit. */
  private refusedAt: number | null = null;
  private raises = 0;

  constructor(
    readonly start: number,
    private readonly maxRaises = 3,
  ) {
    this.current = start;
  }

  get tokens(): number {
    return this.current;
  }

  /** True once the budget has been raised at least once during this run. */
  get raised(): boolean {
    return this.current > this.start;
  }

  /** True once the endpoint refused a raise: this model's own ceiling is in the way. */
  get capped(): boolean {
    return this.refusedAt !== null;
  }

  /** Doubles the ask after a truncated reply. Returns the new ceiling, or null when there is no room left. */
  raise(): number | null {
    const next = this.current * 2;
    if (this.raises >= this.maxRaises) return null;
    if (this.refusedAt !== null && next >= this.refusedAt) return null;
    this.raises++;
    this.current = next;
    return next;
  }

  /**
   * The endpoint rejected the current ask as larger than the model allows.
   * Returns the value to fall back to, or null when even the configured
   * starting budget was refused — which is a config error, not something to
   * retry around.
   */
  lower(): number | null {
    this.refusedAt = this.current;
    if (this.current <= this.start) return null;
    this.current = Math.max(this.start, Math.floor(this.current / 2));
    return this.current;
  }
}

/**
 * How we know the model was thinking, in descending order of certainty: the
 * server counted the tokens, the thinking came back in the response, or the
 * budget ran out with almost no answer to show for it.
 */
export type ReasoningEvidence = 'counted' | 'returned' | 'inferred' | 'none';

/** A reply that ran out of output budget, with what the model spent it on. */
export class TruncatedError extends Error {
  constructor(
    readonly cap: number,
    readonly reasoningTokens: number,
    readonly evidence: ReasoningEvidence,
  ) {
    super(`The response hit the ${cap}-token cap and was truncated.`);
    this.name = 'TruncatedError';
  }
}

/**
 * Roughly how many characters of answer a full output budget buys, at the ~3.5
 * characters per token this action assumes elsewhere. Used only to tell "the
 * answer was too long" apart from "something invisible ate the budget".
 */
export const CHARS_PER_TOKEN = 3.5;

/** A 4xx about the output cap: is the parameter unsupported, or the value too big? */
export function isBudgetOutOfRange(message: string): boolean {
  return (
    /max_(?:completion_)?tokens/.test(message) &&
    /too large|too high|exceed|maximum|at most|greater than|less than or equal|must be (?:<|less)/.test(message)
  );
}
