/**
 * How long one request may take, and what is worth trying again when it does not
 * come back.
 *
 * Both providers used to build their client with a flat ten-minute timeout and
 * `maxRetries: 4`, with nothing tying either number to how much output the call
 * was allowed to generate. That holds up until `max-response-tokens` is raised —
 * which is the first thing the truncation advice tells you to do — because the
 * budget then buys more generation than the clock allows. Every attempt times
 * out by construction, the SDK silently repeats it four more times, and a
 * two-file diff spends fifty minutes to report nothing.
 *
 * A timeout also carries no HTTP status and no `finish_reason`, so it reached
 * neither the 4xx ladder nor the truncation ladder: the one failure the
 * providers could not read was the one their own advice made likely. Deriving
 * the deadline from the budget is what stops it being guaranteed; owning the
 * retries is what stops one timeout costing five.
 */

/**
 * Output tokens per second to assume when turning a budget into a deadline.
 *
 * Far below the ~70 tok/s measured on the thinking-only endpoints that produced
 * this failure, because the two ways of being wrong do not cost the same:
 * assuming too slow a model costs a request that is allowed to overrun and then
 * succeeds, while assuming too fast a one costs the batch.
 */
const SLOWEST_USEFUL_TOKENS_PER_SECOND = 20;

/** Connection, queueing and the round trip — time the model is not generating. */
const OVERHEAD_MS = 60_000;

/** The old flat timeout, kept as a floor: it was never too short for small budgets. */
const MIN_TIMEOUT_MS = 10 * 60 * 1000;

/**
 * A ceiling the budget cannot argue past. Beyond this the likelier reading is a
 * stalled connection than a slow model, and a batch that waits longer has cost
 * more than the review it is trying to produce.
 */
const MAX_TIMEOUT_MS = 40 * 60 * 1000;

/**
 * The deadline for one request, derived from the tokens it is allowed to
 * generate.
 *
 * `overrideSeconds` wins outright when set. An endpoint slower than any rate
 * worth hard-coding needs somewhere to say so; without it, the only remedy for a
 * wrong constant is a fork.
 */
export function requestTimeoutMs(maxOutputTokens: number, overrideSeconds = 0): number {
  if (overrideSeconds > 0) return Math.round(overrideSeconds * 1000);
  const needed = (maxOutputTokens / SLOWEST_USEFUL_TOKENS_PER_SECOND) * 1000 + OVERHEAD_MS;
  return Math.min(MAX_TIMEOUT_MS, Math.max(MIN_TIMEOUT_MS, Math.round(needed)));
}

/** A duration a human can compare to a job log: "12m30s". */
export function describeMs(ms: number): string {
  const total = Math.round(ms / 1000);
  const minutes = Math.floor(total / 60);
  const seconds = total % 60;
  return minutes ? `${minutes}m${String(seconds).padStart(2, '0')}s` : `${seconds}s`;
}

/**
 * Statuses where the same request, sent again, can legitimately succeed: the
 * server is busy, rate-limiting, or briefly broken.
 *
 * This list is the SDK's own, restated because the retrying is now ours. Taking
 * `maxRetries` to zero is the only way to stop a timeout being multiplied by
 * five — the SDK cannot be told to retry some failures and not others — and
 * dropping rate-limit handling along with it would trade one bug for another.
 */
export function isTransientStatus(status: number | undefined): boolean {
  if (status === undefined) return false;
  return status === 408 || status === 409 || status === 429 || status >= 500;
}

/**
 * How much of its own deadline a failure has to spend before it is read as one.
 *
 * Half is the first cut, and the gap it has to separate is wide: a busy server
 * answers 500 in seconds, while the gateway that produced this bug held every
 * connection for fifteen minutes before answering 504.
 */
const DEADLINE_SHARE = 0.5;

/**
 * Whether a failure arrived late enough in its own deadline to be a deadline.
 *
 * `isTransientStatus` reads every 5xx as "the server is busy or briefly broken,
 * send it again". For 500, 502 and 503 that is right. For a 504 from a gateway
 * that closes every connection at a fixed limit it is not: the request did not
 * fail, it ran out of somebody else's clock, and the identical batch at the
 * identical budget runs out of it again. Eight such 504s across three runs landed
 * between 15m00s and 15m05s — a wall, not a busy server — and each one cost
 * fifteen minutes before a backoff of one second.
 *
 * Worse, the two were mutually exclusive. The client deadline is derived from the
 * budget, so at `max_response_tokens: 32000` it is 27m40s against this gateway's
 * fifteen minutes: the gateway always answered first, `APIConnectionTimeoutError`
 * could never be raised, and the degrade ladder that handles exactly this failure
 * was unreachable by construction.
 *
 * Elapsed time is the only thing that tells the two apart, so it is what decides.
 * A server that answers quickly keeps the backoff it has; one that held the
 * connection to the end of its rope is reporting a deadline, and the answer to a
 * deadline is to generate less, not to ask again.
 */
export function isLateFailure(elapsedMs: number, timeoutMs: number): boolean {
  return timeoutMs > 0 && elapsedMs >= timeoutMs * DEADLINE_SHARE;
}

const BASE_BACKOFF_MS = 1000;
const MAX_BACKOFF_MS = 30_000;

/**
 * How many times a transient failure may be retried, and how long to wait first.
 *
 * Exponential from one second, and never below what the server asked for in
 * `Retry-After` — a rate limiter that names a delay knows better than the
 * backoff curve does.
 */
export class TransientRetries {
  private used = 0;

  constructor(private readonly limit = 3) {}

  /** How many retries have been spent, for a message that says so. */
  get attempts(): number {
    return this.used;
  }

  /** Milliseconds to wait before trying again, or null when there are none left. */
  next(serverAskedForMs?: number | null): number | null {
    if (this.used >= this.limit) return null;
    const backoff = BASE_BACKOFF_MS * 2 ** this.used;
    this.used++;
    return Math.min(MAX_BACKOFF_MS, Math.max(backoff, serverAskedForMs ?? 0));
  }
}

function readHeader(headers: unknown, name: string): string | null {
  if (!headers) return null;
  // `headers` is a Headers instance on some SDK versions and a plain object on
  // others; neither is worth a type assertion that could be wrong at runtime.
  const get = (headers as { get?: unknown }).get;
  if (typeof get === 'function') {
    const value = (get as (k: string) => unknown).call(headers, name);
    return typeof value === 'string' ? value : null;
  }
  const value = (headers as Record<string, unknown>)[name];
  return typeof value === 'string' ? value : null;
}

/**
 * The delay a rate limiter asked for, in milliseconds. Accepts both forms the
 * header is defined in — a count of seconds, or an HTTP date — and returns null
 * when it is absent or unparseable, which leaves the caller on its own backoff.
 */
export function retryAfterMs(headers: unknown, now = Date.now()): number | null {
  const raw = readHeader(headers, 'retry-after')?.trim();
  if (!raw) return null;
  const seconds = Number(raw);
  if (Number.isFinite(seconds)) return Math.max(0, seconds * 1000);
  const at = Date.parse(raw);
  return Number.isFinite(at) ? Math.max(0, at - now) : null;
}

export function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}
