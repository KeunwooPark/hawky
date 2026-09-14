import assert from 'node:assert/strict';
import { test } from 'node:test';
import { screenFinding } from '../src/util/finding.js';
import type { Finding } from '../src/types.js';

const finding = (title: string): Finding => ({
  path: 'src/a.ts',
  line: 1,
  severity: 'medium',
  confidence: 0.9,
  category: 'over-engineering',
  title,
  body: 'body',
});

const PATCH = '+  const retries = new TransientRetries();\n+  await sleep(wait);\n';

test('an ordinary finding is published as written', () => {
  assert.equal(screenFinding(finding('`TransientRetries` never resets between batches'), PATCH), null);
});

test('a finding asserting something is a duplicate of itself is withheld', () => {
  // Reported verbatim, with the identifier replaced by a stand-in of the same
  // shape: a truncated word pair and a five-character hex suffix, on a diff of
  // one changed line. Unfalsifiable, and it turned a required check red.
  const reason = screenFinding(
    finding('delete: `fix-versn-ab12c` is a speculative, bug-for-bug duplicate of `fix-versn-ab12c`'),
    PATCH,
  );

  assert.match(reason ?? '', /duplicate of itself/);
});

test('the self-reference check does not need the identifier to be absent', () => {
  // The two rules are independent: a title can name code that is really there
  // and still assert something that cannot hold of it.
  const reason = screenFinding(finding('`sleep` is an exact copy of `sleep`'), PATCH);
  assert.match(reason ?? '', /duplicate of itself/);
});

test('one identifier named twice without a relation between them is left alone', () => {
  // Ordinary English. What makes the reported title degenerate is the assertion
  // of sameness, not the repetition.
  assert.equal(screenFinding(finding('`sleep` is not awaited when `sleep` is re-entered'), PATCH), null);
});

test('two different identifiers around a relation word are left alone', () => {
  // The finding this check must never eat: a real duplicate, which is two things.
  assert.equal(screenFinding(finding('`sleep` duplicates `pause` in the retry helper'), PATCH), null);
});

test('a finding whose every named identifier is absent from the file is withheld', () => {
  const reason = screenFinding(finding('`fix-versn-ab12c` leaks the caller handle'), PATCH);
  assert.match(reason ?? '', /absent from the file/);
});

test('naming something outside the diff alongside something in it is fine', () => {
  // Well-formed findings do this constantly: the replacement being proposed is
  // not in the diff, which is the point of proposing it.
  assert.equal(screenFinding(finding('`sleep` should use `setTimeout.promisify` instead'), PATCH), null);
});

test('a finding that names no code at all is not screened on identifiers', () => {
  assert.equal(screenFinding(finding('the retry loop never terminates on a timeout'), PATCH), null);
});

test('an empty patch proves nothing, so nothing is withheld on it', () => {
  // Unverifiable is not the same as false. A file whose patch text is unavailable
  // must not turn every finding on it into a discard.
  assert.equal(screenFinding(finding('`whatever-xyz` is undefined here'), ''), null);
});

test('the reason never quotes the finding it rejected', () => {
  // A reason can reach the same pull request comment the finding would have.
  const poison = 'DISREGARD-PREVIOUS-ANSWER';
  const reason = screenFinding(finding(`\`${poison}\` is a duplicate of \`${poison}\``), PATCH);

  assert.ok(reason);
  assert.doesNotMatch(reason, /DISREGARD/);
});
