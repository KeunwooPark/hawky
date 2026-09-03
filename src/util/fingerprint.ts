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
