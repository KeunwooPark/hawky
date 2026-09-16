import assert from 'node:assert/strict';
import { test } from 'node:test';
import { batchFiles, getCompareDiff, parsePatch } from '../src/gh/diff.js';
import { resolveAnchor } from '../src/gh/review.js';
import { parseJsonObject } from '../src/llm/json.js';
import { extractFingerprints, findingFingerprint, marker, sameClaim } from '../src/util/fingerprint.js';
import { captureWarnings } from './warnings.js';
import type { Config } from '../src/config.js';
import type { DiffFile, Finding } from '../src/types.js';

const PATCH = [
  '@@ -1,4 +1,6 @@',
  ' const a = 1;',
  '-const b = 2;',
  '+const b = 3;',
  '+const c = 4;',
  ' const d = 5;',
  ' const e = 6;',
  '@@ -20,3 +22,4 @@',
  ' function f() {',
  '+  return 1;',
  ' }',
].join('\n');

test('parsePatch tracks head line numbers across hunks', () => {
  const { commentableLines } = parsePatch(PATCH);
  // First hunk starts at head line 1: context 1, added 2 and 3, context 4 and 5.
  assert.deepEqual([...commentableLines].sort((a, b) => a - b), [1, 2, 3, 4, 5, 22, 23, 24]);
});

test('parsePatch does not consume a head line for removed lines', () => {
  const { annotated } = parsePatch(PATCH);
  assert.match(annotated, /^\s+2 \+const b = 3;$/m);
  assert.match(annotated, /^\s+- const b = 2;$/m);
});

test('parsePatch handles a hunk header without a line count', () => {
  const { commentableLines } = parsePatch(['@@ -0,0 +1 @@', '+only line'].join('\n'));
  assert.deepEqual([...commentableLines], [1]);
});

function fileWith(lines: number[]): DiffFile {
  return {
    path: 'a.ts',
    status: 'modified',
    additions: lines.length,
    deletions: 0,
    patch: '',
    commentableLines: new Set(lines),
    annotated: '',
  };
}

function finding(line: number, end?: number): Finding {
  return {
    path: 'a.ts',
    line,
    end_line: end ?? null,
    severity: 'high',
    confidence: 0.9,
    category: 'correctness',
    title: 't',
    body: 'b',
  };
}

/** A file whose diff is far larger than any batch budget under test. */
function largeFile(addedLines: number): DiffFile {
  const patch = [
    `@@ -1,1 +1,${addedLines} @@`,
    ...Array.from({ length: addedLines }, (_, i) => `+  const value${i} = ${i};`),
  ].join('\n');
  const { annotated, commentableLines } = parsePatch(patch);
  return { ...fileWith([]), patch, annotated, commentableLines };
}

test('resolveAnchor rejects a line that is not in the diff', () => {
  assert.equal(resolveAnchor(finding(99), fileWith([1, 2, 3])), null);
});

test('resolveAnchor keeps a contiguous multi-line range', () => {
  assert.deepEqual(resolveAnchor(finding(2, 4), fileWith([1, 2, 3, 4])), { line: 4, startLine: 2 });
});

test('resolveAnchor collapses a range that crosses a gap in the diff', () => {
  // 2..5 spans a hunk boundary; GitHub would 422, so fall back to a single line.
  assert.deepEqual(resolveAnchor(finding(2, 5), fileWith([1, 2, 3, 20, 21])), { line: 2 });
});

test('resolveAnchor collapses an implausibly long range', () => {
  const lines = Array.from({ length: 60 }, (_, i) => i + 1);
  assert.deepEqual(resolveAnchor(finding(1, 55), fileWith(lines)), { line: 1 });
});

test('batchFiles packs files under the character budget', () => {
  const files = [1, 2, 3, 4].map((n) => ({ ...fileWith([1]), path: `f${n}.ts`, annotated: 'x'.repeat(400) }));
  // Each file costs 400 chars of diff plus path and framing overhead, so two fit.
  const batches = batchFiles(files, 1000);
  assert.equal(batches.length, 2);
  assert.ok(batches.every((b) => b.length <= 2));
  assert.equal(batches.flat().length, 4);
});

test('batchFiles truncates a file larger than a whole batch', () => {
  const [batch] = batchFiles([largeFile(200)], 1000);
  assert.equal(batch.length, 1);
  assert.match(batch[0].annotated, /more diff line\(s\) in this file are not shown/);
});

test('batchFiles truncates on a line boundary, never mid-statement', () => {
  const [[file]] = batchFiles([largeFile(200)], 1000);

  // Half a statement reads as a defect, so the model must never be shown one.
  const body = file.annotated.split('\n\n...')[0];
  const shown = body.split('\n').filter((l) => l.includes('const value'));
  assert.ok(shown.length > 1, 'expected several lines to survive the cut');
  for (const line of shown) {
    assert.match(line, /const value\d+ = \d+;$/, `severed line: ${JSON.stringify(line)}`);
  }
});

test('truncating a file prunes the lines it invites comments on', () => {
  const full = largeFile(200);
  const [[file]] = batchFiles([full], 1000);

  // Anchoring to a line that was cut away makes GitHub reject the whole review.
  assert.ok(file.commentableLines.size < full.commentableLines.size);
  assert.ok(file.commentableLines.size > 0);
  const lastShown = Math.max(...file.commentableLines);
  assert.ok(!file.commentableLines.has(lastShown + 1), 'kept a line that is no longer shown');
  for (const line of file.commentableLines) {
    assert.match(file.annotated, new RegExp(`^\\s*${line} \\+`, 'm'), `line ${line} is not in the diff`);
  }
});

/** Minimal Octokit stand-in for the compare endpoint getCompareDiff calls. */
function compareStub(files: Array<Record<string, unknown>>) {
  return { rest: { repos: { compareCommitsWithBasehead: async () => ({ data: { files } }) } } } as never;
}

const diffCfg = { include: [], exclude: [], maxFiles: 60 } as unknown as Config;

const compare = (files: Array<Record<string, unknown>>, over: Partial<Config> = {}) =>
  getCompareDiff(compareStub(files), 'o', 'r', 'base', 'head', { ...diffCfg, ...over } as Config);

test('files withheld from the review are reported back, not silently forgotten', async () => {
  // A definition in any of these is invisible to the model, which is how a review
  // ends up calling a symbol undefined.
  const { files, omitted } = await compare(
    [
      { filename: 'src/a.ts', status: 'modified', additions: 1, deletions: 0, patch: '@@ -1,1 +1,1 @@\n+const a = 1;' },
      { filename: 'src/logo.png', status: 'added', additions: 0, deletions: 0 },
      { filename: 'src/gone.ts', status: 'removed', additions: 0, deletions: 9, patch: '@@ -1,1 +0,0 @@\n-const x = 1;' },
      { filename: 'package-lock.json', status: 'modified', additions: 5, deletions: 1, patch: '@@ -1,1 +1,5 @@\n+dep' },
    ],
    { exclude: ['**/package-lock.json'] },
  );

  assert.deepEqual(
    files.map((f) => f.path),
    ['src/a.ts'],
  );
  assert.deepEqual([...omitted].sort(), ['package-lock.json', 'src/gone.ts', 'src/logo.png']);
});

test('files cut by max_files are reported as omitted too', async () => {
  const many = [1, 2, 3].map((n) => ({
    filename: `src/f${n}.ts`,
    status: 'modified',
    additions: 1,
    deletions: 0,
    patch: `@@ -1,1 +1,1 @@\n+const v = '${'x'.repeat(n * 30)}';`,
  }));

  const { result } = await captureWarnings(() => compare(many, { maxFiles: 2 }));

  assert.equal(result.files.length, 2);
  // Smallest are reviewed first, so the largest is the one that gets cut.
  assert.deepEqual(result.omitted, ['src/f3.ts']);
});

test('parseJsonObject recovers JSON from a fenced or chatty response', () => {
  assert.deepEqual(parseJsonObject('{"a":1}'), { a: 1 });
  assert.deepEqual(parseJsonObject('```json\n{"a":1}\n```'), { a: 1 });
  assert.deepEqual(parseJsonObject('Sure! {"a":1} Hope that helps.'), { a: 1 });
  assert.throws(() => parseJsonObject('no json here'), /did not return JSON/);
});

test('fingerprints survive a line move but distinguish different findings', () => {
  const a = findingFingerprint('a.ts', 'correctness', 'Null deref on empty list');
  const b = findingFingerprint('a.ts', 'correctness', 'null deref on empty LIST!');
  const c = findingFingerprint('a.ts', 'security', 'Null deref on empty list');
  assert.equal(a, b);
  assert.notEqual(a, c);
});

/** The three wordings one waived claim came back under on a single pull request. */
const REWORDINGS = [
  '`useDelete` sends the id as a body, but the route reads it from the query string',
  '`useDelete` sends `{ id }` as a request payload while the route reads it from the query string',
  '`useDelete` sends the id as a body, but the delete route reads it from the query string',
];

test('one claim reworded is recognised as the same claim', () => {
  // Each of these arrived as a fresh finding with a fresh id, gated the merge
  // again, and cost the same argument again — the title is the fingerprint, and
  // the title is the field the model rewrites on every run.
  assert.ok(sameClaim(REWORDINGS[0], REWORDINGS[1]));
  assert.ok(sameClaim(REWORDINGS[0], REWORDINGS[2]));
  assert.ok(sameClaim(REWORDINGS[1], REWORDINGS[2]));
});

test('two different findings are not folded into one claim', () => {
  assert.ok(!sameClaim('`sleep` is never awaited on the retry path', REWORDINGS[0]));
  // The check that matters most: same subject, different defect.
  assert.ok(!sameClaim('the retry loop never terminates on a timeout', 'the retry loop is entered twice on a reconnect'));
});

test('a title too thin to judge is never matched by its wording', () => {
  // Three words carry too little to tell a rewording from a different claim.
  assert.ok(!sameClaim('`parse` returns null', '`parse` returns nothing'));
});

test('fingerprints round-trip through a rendered comment body', () => {
  const fp = findingFingerprint('a.ts', 'correctness', 'x');
  const body = `some text\n\n${marker('finding', fp)}`;
  assert.deepEqual(extractFingerprints(body, 'finding'), [fp]);
  assert.deepEqual(extractFingerprints(body, 'refactor'), []);
});
