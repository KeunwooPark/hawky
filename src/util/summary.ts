/**
 * Screening for the one part of a review that is free-form model prose.
 *
 * Every other field this action publishes is constrained: a severity is an enum,
 * a line number is checked against the diff, a finding with no text is dropped.
 * `summary` is a string the model fills however it likes, and it is rendered into
 * a comment on someone's pull request.
 *
 * A run arrived where that string was not a summary of anything. It carried a
 * block of context belonging to an unrelated project, decayed into repeating one
 * clause a dozen times, and ended in imperative text addressed to an assistant.
 * Elsewhere the same class of failure put the model's entire chain of thought in
 * the comment with `{"findings": []}` at the bottom.
 *
 * None of that is detectable by reading it for meaning, and this module does not
 * try. It checks the three properties a two-to-four-sentence summary of a diff
 * has regardless of what it says — it is not a transcript, it does not repeat
 * itself, and it is short — and withholds the text when one of them fails.
 * Withheld rather than truncated: in the run that prompted this the foreign block
 * was at the *front*, so keeping the first N characters keeps precisely the part
 * that should not be published.
 *
 * The reasons below are assembled from counts and never quote the text they
 * rejected. A reason is rendered into the same comment, and echoing a fragment of
 * a summary that was withheld for being instruction-shaped would publish a
 * smaller copy of the problem.
 */

import { containsReasoning } from '../llm/json.js';

/**
 * The longest a summary may be before it is treated as something other than a
 * summary. The schema asks for two to four sentences; this is several times that,
 * so it fires on transcripts and pasted context rather than on a verbose reviewer.
 */
const MAX_SUMMARY_CHARS = 1500;

/**
 * The shortest fragment worth counting as a repeat. Below this, legitimate prose
 * repeats itself constantly — "and", "the run", a short file name.
 */
const MIN_REPEATED_CHARS = 12;

/** How many times one fragment may appear before the text counts as decayed. */
const MAX_REPEATS = 4;

/** The model's summary as it will be published, with whatever was withheld. */
export interface ReviewSummary {
  /** Text that passed screening, or empty when none did. */
  text: string;
  /** One reason per summary that was withheld, in the order the batches ran. */
  withheld: string[];
}

export interface ScreenedSummary {
  /** The model's text when it passed, or empty when it did not. */
  text: string;
  /** Why it was withheld, phrased to follow "withheld: ", or null when it passed. */
  withheld: string | null;
}

/**
 * How many times the most-repeated sentence-like fragment appears, or 0 when
 * nothing repeats enough to matter.
 *
 * Degenerate repetition is what a decayed reply looks like from the outside: the
 * same clause emitted five, eleven, seventeen times in a row. Splitting on
 * sentence terminators and newlines catches it whether the model repeated whole
 * lines or ran them together.
 */
function worstRepetition(text: string): number {
  const counts = new Map<string, number>();
  let worst = 0;
  for (const fragment of text.split(/[\n.;!?]+/)) {
    const normalized = fragment.trim().replace(/\s+/g, ' ').toLowerCase();
    if (normalized.length < MIN_REPEATED_CHARS) continue;
    const seen = (counts.get(normalized) ?? 0) + 1;
    counts.set(normalized, seen);
    if (seen > worst) worst = seen;
  }
  return worst;
}

/**
 * Decide whether a model-written summary is publishable, without judging what it
 * says. Order runs most-diagnostic first: a transcript is also over-long, and
 * naming it as a transcript says more about the run than its length does.
 */
export function screenSummary(raw: string): ScreenedSummary {
  const text = raw.trim();
  if (!text) return { text: '', withheld: null };

  const withhold = (reason: string): ScreenedSummary => ({ text: '', withheld: reason });

  if (containsReasoning(text)) {
    return withhold("it was the model's chain of thought rather than an answer");
  }

  const repeats = worstRepetition(text);
  if (repeats > MAX_REPEATS) {
    return withhold(`it decayed into repeating one line ${repeats} times`);
  }

  if (text.length > MAX_SUMMARY_CHARS) {
    return withhold(
      `it ran to ${text.length.toLocaleString()} characters, where the schema asks for two to four sentences`,
    );
  }

  return { text, withheld: null };
}
