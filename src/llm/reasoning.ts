import type { Reasoning } from '../config.js';

/**
 * The reasoning-effort rungs, least thinking first.
 *
 * `auto` is deliberately not on the scale: it means "send nothing and take
 * whatever this endpoint does by default", which is a position off the ladder
 * rather than a point on it.
 */
const SCALE = ['none', 'minimal', 'low', 'medium', 'high'] as const;

/**
 * Which `reasoning_effort` to ask for, and where to go when the endpoint refuses
 * it or the model thinks past its output budget.
 *
 * Three rules. A value the endpoint has already refused is never asked for again
 * — without that, a rejection and a truncation take turns prescribing each
 * other's failed input, which once cost a run half an hour. A refusal steps
 * *along* the scale rather than off it: omitting the parameter does not mean "no
 * reasoning", it means the model's own default, which is the far end of the scale
 * from the floor a caller who wrote `reasoning: none` was asking for. And the
 * automatic descent stops short of `none`; see `floor`.
 */
export class ReasoningLadder {
  private current: string | null;
  private readonly refused = new Set<string>();
  private steppedOff = false;

  /**
   * The lowest rung this ladder may turn down to on its own.
   *
   * `none` is not a review setting. Reading a diff for defects is the work the
   * thinking does, and a model told not to think answers in seconds having found
   * nothing — which a merge gate cannot tell apart from a clean diff. Arriving
   * there by configuration is the caller's decision, made once and warned about
   * where it is read. Arriving there by retry is this class deciding, on a
   * truncated reply, to trade a batch that fails loudly for a review that passes
   * quietly, and it would do it on a diff nobody was looking at.
   *
   * So the descent stops at `minimal`, and only a caller who asked for `none`
   * outright can be taken back down to it. A ladder already standing on its floor
   * turns down to nothing and says so, which sends the caller to the budget
   * instead — the remedy that buys an answer without giving up the review.
   */
  private readonly floor: number;

  constructor(configured: Reasoning) {
    this.current = configured === 'auto' ? null : configured;
    this.floor = configured === 'none' ? 0 : (SCALE as readonly string[]).indexOf('minimal');
  }

  /** The value to send, or null to send no `reasoning_effort` at all. */
  get effort(): string | null {
    return this.current;
  }

  /** True once a refusal or a truncation moved us off the configured value. */
  get moved(): boolean {
    return this.steppedOff;
  }

  /** Where the current value sits on the scale; past the top when none is sent. */
  private get rung(): number {
    return this.current === null ? SCALE.length : (SCALE as readonly string[]).indexOf(this.current);
  }

  /**
   * The endpoint refused the effort we asked for. Records it and moves to the
   * next rung up — the nearest level to it this endpoint might actually
   * implement — returning the new value, or null when the scale is spent and the
   * parameter has to be dropped after all.
   */
  reject(): string | null {
    if (this.current !== null) this.refused.add(this.current);
    this.current = SCALE.slice(this.rung + 1).find((v) => !this.refused.has(v)) ?? null;
    this.steppedOff = true;
    return this.current;
  }

  /**
   * The reply was truncated and the thinking is where the budget went. Moves to
   * the lowest rung below the current one that this endpoint has not already
   * refused and that sits at or above `floor`, or returns null when there is
   * nothing left to turn down to.
   */
  turnDown(): string | null {
    const next = SCALE.slice(this.floor, this.rung).find((v) => !this.refused.has(v)) ?? null;
    if (next === null) return null;
    this.current = next;
    this.steppedOff = true;
    return next;
  }
}
