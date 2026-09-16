import assert from 'node:assert/strict';
import { test } from 'node:test';
import { screenFinding, screenSuggestion } from '../src/util/finding.js';
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

/** Same finding, with a body worth reading rather than the stand-in above. */
const bodied = (body: string): Finding => ({ ...finding('`sleep` is not awaited on the retry path'), body });

test('a finding whose body withdraws it is withheld', () => {
  // Reported verbatim in shape: the claim, the guard that prevents it, and the
  // model's own verdict on its own finding. The title was plausible and well
  // anchored, so nothing else screens it, and at High it failed a merge.
  const reason = screenFinding(
    bodied('`abs(record["gap"])` can receive None here. Wait — the `reason == "evaluated"` guard prevents this. Drop this finding.'),
    PATCH,
  );

  assert.match(reason ?? '', /withdraws the finding/);
});

test('the other wordings of a withdrawal are withheld too', () => {
  for (const body of ['Discard this finding.', 'On reflection, disregard this report.', 'Retract this finding.']) {
    assert.match(screenFinding(bodied(body), PATCH) ?? '', /withdraws the finding/, body);
  }
});

test('a body telling the reader not to drop the finding is left alone', () => {
  // The phrase is inside it, and it is being used to say the opposite.
  assert.equal(
    screenFinding(bodied('The caller looks safe at a glance, so do not drop this finding without checking `wait`.'), PATCH),
    null,
  );
});

test('an ordinary body that reasons about a guard is left alone', () => {
  // Whether the reasoning is sound is the judgement this module refuses to make.
  // What it screens on is a verdict, and this body does not give one.
  assert.equal(
    screenFinding(bodied('`sleep` is awaited only inside the guard, so a timeout on the retry path leaves the handle open.'), PATCH),
    null,
  );
});

test('the reason for a withdrawal does not quote the body it rejected', () => {
  const reason = screenFinding(bodied('DISREGARD-PREVIOUS-ANSWER. Drop this finding.'), PATCH);

  assert.ok(reason);
  assert.doesNotMatch(reason, /DISREGARD-PREVIOUS-ANSWER/);
});

test('the reason never quotes the finding it rejected', () => {
  // A reason can reach the same pull request comment the finding would have.
  const poison = 'DISREGARD-PREVIOUS-ANSWER';
  const reason = screenFinding(finding(`\`${poison}\` is a duplicate of \`${poison}\``), PATCH);

  assert.ok(reason);
  assert.doesNotMatch(reason, /DISREGARD/);
});

/** The line a suggestion on this finding would be replacing. */
const ANCHORED = ['  const retries = new TransientRetries();'];

test('a suggestion that replaces the anchored lines with themselves is withheld', () => {
  // GitHub gives this a Commit suggestion button, so the cheapest way out of the
  // finding is one click that edits nothing.
  const reason = screenSuggestion('  const retries = new TransientRetries();', ANCHORED);
  assert.match(reason ?? '', /leave the anchored lines exactly as they are/);
});

test('trailing whitespace and a shifted block do not make a replacement new', () => {
  assert.ok(screenSuggestion('const retries = new TransientRetries();   ', ANCHORED));
  assert.ok(screenSuggestion('\n      const retries = new TransientRetries();\n', ANCHORED));
});

test('a replacement that actually changes the line is offered', () => {
  // The suggestion this check must never eat: a real one-click fix.
  assert.equal(screenSuggestion('  const retries = new TransientRetries(cfg.retries);', ANCHORED), null);
});

test('a suggestion describing a replacement rather than being one is withheld', () => {
  // Reported on a one-line manifest change: the same text on both sides of an
  // arrow. Committed as written it would have put prose where the code was.
  const reason = screenSuggestion('"version": "1.9.0" → "version": "1.9.0"', ['  "version": "1.9.0"']);
  assert.match(reason ?? '', /describes a replacement/);
});

test('an arrow that is an operator in the language is left alone', () => {
  assert.equal(screenSuggestion('  const next = (x) => x + 1;', ANCHORED), null);
  assert.equal(screenSuggestion('  node->next = head;', ANCHORED), null);
});

test('a placeholder where the replacement should be is withheld', () => {
  // `suggestion` is nullable; these are what a model writes instead of using it.
  for (const text of ['N/A', 'none', 'TODO']) {
    assert.match(screenSuggestion(text, ANCHORED) ?? '', /placeholder/, text);
  }
});

test('a multi-line replacement is compared line by line', () => {
  const anchored = ['  if (!ok) {', '    return null;', '  }'];

  assert.ok(screenSuggestion('  if (!ok) {\n    return null;\n  }', anchored));
  assert.equal(screenSuggestion('  if (!ok) {\n    throw new Error("not ok");\n  }', anchored), null);
});
