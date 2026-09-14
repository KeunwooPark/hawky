/**
 * Screening for the other half of a review that is free-form model prose.
 *
 * `summary` was screened first because it is the obviously unconstrained field.
 * A finding's `title` is written just as freely, and a corrupted one costs more:
 * a bad summary misleads a reader, a bad finding stops a merge.
 *
 * One arrived on a diff of a single changed line — a version string moved from
 * one semver to the next, one insertion and one deletion — asserting at medium
 * severity that an identifier occurring nowhere in the repository was a
 * "bug-for-bug duplicate" of itself, and claiming a net of -1 lines for a change
 * that deleted nothing. At `fail-on-severity: medium` it turned the required
 * check red. Clearing it cost a waiver and a re-run of the job: a human
 * judgement call spent on a sentence that cannot be true of any code.
 *
 * As with the summary screens, nothing here reads the text for meaning. Two
 * properties hold of a finding that is about the diff it is anchored to,
 * whatever it goes on to say: it does not assert that something is a duplicate
 * of itself, and where it names code in backticks, at least some of that code is
 * in the file it is pointing at.
 *
 * Only the title is screened. It is where the reported damage was, it is what
 * the fingerprint is keyed on, and it is the one line a reader sees in the
 * collapsed view. A body legitimately names things outside the diff — a standard
 * library call, a type from another module, a replacement being proposed — so
 * the same rules there would fire on well-formed findings.
 *
 * The reasons returned below are assembled from the rule that fired and never
 * quote the text they rejected, for the reason the summary module does not: a
 * reason can reach the same pull request comment, and echoing a fragment of
 * something withheld as degenerate publishes a smaller copy of it.
 */

import type { Finding } from '../types.js';

/** Code the model named explicitly. Two characters is the shortest worth matching. */
const BACKTICKED = /`([^`\n]{2,})`/g;

/**
 * Words asserting that one thing is a restatement of another.
 *
 * Only these turn two mentions of one identifier into a claim about it. Without
 * a relation in between, an identifier named twice in a title is ordinary
 * English — "`parse` fails when `parse` is re-entered" says something.
 */
const RELATION =
  /\b(?:duplicat\w*|copy|copies|clone|clones|reimplement\w*|reimplementation|identical|same|equivalent|alias|aliases|wrapper|wraps|supersed\w*|replac\w*|shadows|repeats)\b/i;

function backticked(text: string): Array<{ id: string; start: number; end: number }> {
  const out: Array<{ id: string; start: number; end: number }> = [];
  for (const m of text.matchAll(BACKTICKED)) {
    const id = m[1].trim();
    if (!id) continue;
    const start = m.index ?? 0;
    out.push({ id, start, end: start + m[0].length });
  }
  return out;
}

/**
 * True when the title claims a relation between one identifier and itself.
 *
 * `X is a bug-for-bug duplicate of X` is unfalsifiable: it cannot describe any
 * diff, because there is no pair of things for the relation to hold between.
 * Detecting it needs no understanding of what X is — only that the same string
 * appears on both sides of a word asserting sameness.
 *
 * A title naming two genuinely distinct things that happen to share a name — the
 * same function defined in two modules — trips this. That is a real cost and an
 * accepted one: such a title is already unreadable, since nothing in it says
 * which of the two is meant, and the disposition is to withhold one finding with
 * the reason logged rather than to fail anything.
 */
function assertsRelationToItself(title: string): boolean {
  const spots = new Map<string, Array<{ start: number; end: number }>>();
  for (const { id, start, end } of backticked(title)) {
    spots.set(id, [...(spots.get(id) ?? []), { start, end }]);
  }
  for (const places of spots.values()) {
    for (let i = 1; i < places.length; i++) {
      if (RELATION.test(title.slice(places[i - 1].end, places[i].start))) return true;
    }
  }
  return false;
}

/**
 * True when the title names code in backticks and none of it is in the file.
 *
 * The reported finding named an identifier shaped like a branch or task slug — a
 * truncated word pair and a short hex suffix — that occurs nowhere in the
 * repository, let alone the diff. Whatever produced it, a finding whose every
 * named identifier is absent from the file it is anchored to is not about that
 * file, and the action is holding both at the moment it renders the comment.
 *
 * `none of them` rather than `any of them` deliberately. A well-formed finding
 * routinely names something that is not in the diff — the replacement it
 * proposes, the standard library call to use instead — alongside the code it is
 * actually about. Requiring every identifier to be present would discard those;
 * requiring one keeps the check to titles that touch the file nowhere at all.
 *
 * The whole file patch is searched rather than the single hunk the finding
 * anchors to. A definition a few lines outside the anchor is still this file's
 * code, and the mis-anchor check already covers findings pointing at lines the
 * diff does not contain.
 */
function namesNothingInTheFile(title: string, patch: string): boolean {
  const ids = backticked(title).map((b) => b.id);
  if (!ids.length) return false;
  // No patch text to check against: unverifiable, so nothing is claimed.
  if (!patch.trim()) return false;
  return !ids.some((id) => patch.includes(id));
}

/**
 * Why this finding should not be published, or null when it should.
 *
 * Phrased to follow "Discarded …: ", and never quoting the finding.
 */
export function screenFinding(finding: Finding, patch: string): string | null {
  const title = finding.title.trim();
  // An empty finding is dropped before this, by the check that reads both fields.
  if (!title) return null;

  if (assertsRelationToItself(title)) {
    return 'its title asserts that something is a duplicate of itself, which cannot be true of any diff';
  }
  if (namesNothingInTheFile(title, patch)) {
    return 'every identifier its title names is absent from the file it points at';
  }
  return null;
}
