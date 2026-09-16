import { createHash } from 'node:crypto';

const MARKER = 'hawky';
const VERSION = 'v1';

function normalize(text: string): string {
  return text.toLowerCase().replace(/[^a-z0-9]+/g, ' ').trim();
}

function hash(parts: string[]): string {
  return createHash('sha256').update(parts.join(' ')).digest('hex').slice(0, 16);
}

/**
 * Identifies a finding across runs so re-review on every push does not repost
 * the same comment. Deliberately excludes the line number: the same defect
 * shifted down a few lines is still the same defect.
 */
export function findingFingerprint(path: string, category: string, title: string): string {
  return hash([path, category, normalize(title)]);
}

/**
 * Words too common in a review title to say anything about which claim it is.
 * Dropped before two titles are compared, so the comparison is about the nouns
 * and verbs that carry the finding rather than about English.
 */
const COMMON = new Set([
  'the', 'this', 'that', 'these', 'those', 'and', 'but', 'not', 'for', 'from', 'with', 'without', 'into',
  'onto', 'over', 'under', 'via', 'when', 'while', 'where', 'then', 'than', 'because', 'its', 'are', 'was',
  'were', 'been', 'being', 'has', 'have', 'had', 'can', 'could', 'should', 'would', 'may', 'might', 'will',
  'does', 'did', 'done', 'each', 'other', 'same', 'only', 'still', 'also', 'any', 'all', 'here', 'there',
]);

/** Below this many significant words, a title is too thin to judge by its wording. */
const MIN_CLAIM_WORDS = 4;

/** How much of two titles' vocabulary must coincide before they are one claim. */
const SAME_CLAIM_RATIO = 0.6;

function claimWords(title: string): Set<string> {
  return new Set(normalize(title).split(' ').filter((word) => word.length > 2 && !COMMON.has(word)));
}

/**
 * True when two titles are the same claim written twice.
 *
 * The fingerprint is keyed on the title, and the title is free model prose
 * regenerated from scratch on every run — the one field guaranteed not to be
 * stable. So a waiver could be voided by the model rephrasing itself: one claim
 * came back seven times under seven wordings, each arriving as a new finding that
 * gated the merge again and cost the same argument again.
 *
 * Deliberately blunt: shared vocabulary, ignoring word order and the words every
 * review title contains. It recognises a claim reworded, which is what the reports
 * show; it does not recognise one restated in synonyms, and it is not meant to.
 * The threshold is set where a false match costs the least — this only ever
 * compares against findings a maintainer has already waived on the same file, the
 * match is reported in the summary as a match rather than silently swallowed, and
 * the remedy for a wrong one is the remedy for any wrong waiver.
 */
export function sameClaim(a: string, b: string): boolean {
  const left = claimWords(a);
  const right = claimWords(b);
  if (left.size < MIN_CLAIM_WORDS || right.size < MIN_CLAIM_WORDS) return false;

  const shared = [...left].filter((word) => right.has(word)).length;
  return shared / (left.size + right.size - shared) >= SAME_CLAIM_RATIO;
}

export function refactorFingerprint(title: string, files: string[]): string {
  return hash([normalize(title), [...files].sort().join(',')]);
}

/** Hidden HTML comment carrying the fingerprint, invisible in rendered markdown. */
export function marker(kind: string, fingerprint: string): string {
  return `<!-- ${MARKER}:${VERSION}:${kind}:${fingerprint} -->`;
}

export function extractFingerprints(body: string | null | undefined, kind: string): string[] {
  if (!body) return [];
  const re = new RegExp(`<!-- ${MARKER}:${VERSION}:${kind}:([0-9a-f]+) -->`, 'g');
  return [...body.matchAll(re)].map((m) => m[1]);
}

export const SUMMARY_MARKER = `<!-- ${MARKER}:${VERSION}:summary -->`;

/** True for a comment this action wrote, marker and all. */
export function isHawkyComment(body: string | null | undefined): boolean {
  return Boolean(body?.includes(`<!-- ${MARKER}:${VERSION}:`));
}
