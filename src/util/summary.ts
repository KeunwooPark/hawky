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
 * try. It checks the four properties a two-to-four-sentence summary of a diff has
 * regardless of what it says — it is not a transcript, it is prose all the way
 * through, it does not repeat itself, and it is short — and withholds the text
 * when one of them fails. Withheld rather than truncated: in the run that
 * prompted this the foreign block was at the *front*, so keeping the first N
 * characters keeps precisely the part that should not be published — and a later
 * run put its damage at the *end*, so there is no end of the field to trust
 * either.
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

/**
 * The seam where something that was not prose has been spliced into prose.
 *
 * A run arrived whose summary opened with an accurate sentence about the diff and
 * then carried a stray `}`, a tab, and two lines asserting a critical finding and
 * an unwaived dismissal — in a run that found nothing at all. It is short,
 * repeats nothing, and carries no reasoning tag, so every check above lets it
 * through, and what it claims is contradicted by counts this action holds at the
 * moment it renders the comment.
 *
 * Detectable there is not the claim but the join: a tab, or a line opening on a
 * closing bracket. Two-to-four sentences of review English contain neither, and
 * matching on the shape rather than on the assertion keeps this module out of the
 * business of judging what a summary says.
 *
 * A summary that fences a snippet of code trips this. That is a real cost and an
 * accepted one: the schema asks for sentences, the disposition is to withhold one
 * field with the reason stated rather than to fail the run, and the alternative —
 * tracking fence state to exempt the inside of a block — is more machinery than a
 * prose check should carry.
 */
const STRUCTURAL_DEBRIS = /\t|^[ ]*[}\])]/m;

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

  // Kept with the transcript check rather than below: these two say the text is
  // not a summary at all, where the two after them say it is a summary that came
  // apart. A transcript names itself more precisely than its seams do, so it
  // keeps the first word.
  if (STRUCTURAL_DEBRIS.test(text)) {
    return withhold('it carried fragments of a structure rather than prose');
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

/** An assertion that this review produced a finding. */
const CLAIMS_FINDING =
  /\b(?:had|has|have|found|identified|flagged|raised|reported)\s+(?:\d+\s+|an?\s+|the\s+|some\s+)?(?:\w+[- ]){0,3}(?:finding|defect|violation|issue)s?\b/i;

/** An assertion that a finding in this review was set aside. */
const CLAIMS_DISMISSAL = /\bwithout a waiver\b|\bhas been (?:ignored|dismissed|waived|overridden)\b/i;

/** What turns a claim into its denial, which is a thing a clean run may say. */
const NEGATED = /\b(?:no|not|none|nothing|never|n't|zero)\b/i;

/**
 * Claims about this review that a run returning no findings cannot support.
 *
 * The tail that prompted the shape check above also asserted something the action
 * already knew to be false: that the review had a critical finding, and that it
 * had been ignored without a waiver, in a run whose own count was zero. The shape
 * check catches that particular text by its seams, but a cleanly joined sentence
 * making the same claim would pass, and a reader has no way to tell which of two
 * contradictory statements in one comment is the true one.
 *
 * This is the only check here that reads what a summary says, so it is kept as
 * narrow as it can be made. It runs only when the model returned no findings at
 * all — a dismissal is a waived finding, so zero findings means zero of those too
 * — and it matches assertions that a finding or a waiver *exists*, with negated
 * sentences left alone so that saying nothing was found stays sayable.
 *
 * It will be wrong eventually in a way the shape checks will not, because a diff
 * that changes this action's own gate is reviewed in the vocabulary these patterns
 * look for. That is the reason it withholds one field with the reason named rather
 * than failing the run, and the reason it is kept apart from the checks that judge
 * no meaning at all.
 */
export function screenSummaryClaims(raw: string, findingCount: number): string | null {
  if (findingCount > 0) return null;
  const text = raw.trim();
  if (!text) return null;

  for (const sentence of text.split(/[.;!?\n]+/)) {
    if (CLAIMS_DISMISSAL.test(sentence)) {
      return 'it described a waived finding in a run that produced none';
    }
    if (CLAIMS_FINDING.test(sentence) && !NEGATED.test(sentence)) {
      return 'it described a finding in a run that produced none';
    }
  }
  return null;
}
