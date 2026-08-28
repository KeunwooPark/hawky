import assert from 'node:assert/strict';
import { test } from 'node:test';
import { batchFiles, parsePatch } from '../src/gh/diff.js';
import { resolveAnchor } from '../src/gh/review.js';
import { parseJsonObject } from '../src/llm/json.js';
import { extractFingerprints, findingFingerprint, marker } from '../src/util/fingerprint.js';
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
  const [batch] = batchFiles([{ ...fileWith([1]), annotated: 'x'.repeat(5000) }], 1000);
  assert.equal(batch.length, 1);
  assert.ok(batch[0].annotated.length < 1200);
  assert.match(batch[0].annotated, /diff truncated/);
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

test('fingerprints round-trip through a rendered comment body', () => {
  const fp = findingFingerprint('a.ts', 'correctness', 'x');
  const body = `some text\n\n${marker('finding', fp)}`;
  assert.deepEqual(extractFingerprints(body, 'finding'), [fp]);
  assert.deepEqual(extractFingerprints(body, 'refactor'), []);
});
