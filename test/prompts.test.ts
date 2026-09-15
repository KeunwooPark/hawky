import assert from 'node:assert/strict';
import { test } from 'node:test';
import { buildSystemPrompt, buildUserPrompt } from '../src/prompts.js';
import { parsePatch } from '../src/gh/diff.js';
import type { Config, Mode } from '../src/config.js';
import type { Target } from '../src/gh/client.js';
import type { DiffFile, PriorDefinition } from '../src/types.js';

const prompt = (mode: Mode = 'review', over: Partial<Config> = {}) =>
  buildSystemPrompt(
    {
      guidelines: '',
      minConfidence: 0.6,
      minSeverity: 'medium',
      maxComments: 15,
      maxIssues: 3,
      ...over,
    } as Config,
    mode,
  );

test('the reuse and shrink checks are part of what a review reports', () => {
  const p = prompt();

  // They live beside the defect list rather than in a section of their own, so
  // there is no longer a heading or a switch standing between them and a review.
  assert.ok(!p.includes('## Over-engineering'));
  assert.match(p, /## What to report/);
  assert.match(p, /Is it already in this repository\?/);
  assert.match(p, /Can it be one line\?/);
  assert.match(p, /more than the minimum code that works/);
});

test('the four rungs a diff cannot settle are gone', () => {
  const p = prompt();

  // YAGNI and "an already-installed dependency" need intent and a manifest the
  // diff does not carry; "name the function" invites a confidently invented one.
  for (const dropped of ['YAGNI', 'standard library', 'native platform feature', 'already-installed dependency']) {
    assert.ok(!p.includes(dropped), `the prompt still asks about: ${dropped}`);
  }
});

test('the tag vocabulary is the two checks that survived', () => {
  const p = prompt();

  assert.ok(p.includes('`reuse:`'));
  assert.ok(p.includes('`shrink:`'));
  for (const gone of ['`delete:`', '`stdlib:`', '`native:`', '`yagni:`']) {
    assert.ok(!p.includes(gone), `the prompt still offers the tag ${gone}`);
  }
  assert.ok(p.includes('`category` set to `over-engineering`'));
});

test('a reuse finding must point at the code it claims already exists', () => {
  // The reviewer sees hunks, not a checkout. Without this, "it is probably
  // already somewhere in here" is a finding it can neither settle nor drop.
  assert.match(prompt(), /if you cannot point to it, there is nothing to report/);
});

test('the severity ceiling still stands between these findings and the gate', () => {
  // `capOverEngineering` enforces it in code as well; a reuse finding that
  // reached `high` would fail a merge gate built for defects.
  assert.match(prompt(), /never `high` or `critical`/);
});

test('the review never asks for the simplifications that are not safe to make', () => {
  const p = prompt();
  for (const guard of ['trust boundary', 'data loss', 'security measure', 'accessibility']) {
    assert.ok(p.includes(guard), `missing guard: ${guard}`);
  }
  // Deleting code is in scope; opinions about how it is written are not.
  assert.ok(p.includes('The no-style rule below still holds.'));
});

test('refactor-only runs prefer the refactors that delete code, without the finding tags', () => {
  const p = prompt('refactor');

  assert.ok(p.includes('A refactor that deletes a layer beats one'));
  // There are no inline comments in this mode, so the tag vocabulary is noise.
  assert.ok(!p.includes('`shrink:`'));
  assert.ok(!p.includes('`reuse:`'));
});

test('a review-only run says nothing about refactors deleting layers', () => {
  assert.ok(!prompt('review').includes('deletes a layer'));
});

test('refactor-only runs are told to leave the required findings array empty', () => {
  // The schema requires `findings` in every mode and this one discards whatever
  // comes back in it, so an unexplained mandatory field is output nobody reads.
  const p = prompt('refactor');

  assert.match(p, /Return `findings` as an empty array/);
  assert.match(p, /put everything you have to say in `refactors` and `summary`/);
});

test('refactor-only runs drop the rules about fields only a finding has', () => {
  const p = prompt('refactor', { minSeverity: 'high' });

  for (const findingOnly of [
    'Anchor every finding',
    '`confidence`',
    '`suggestion`',
    'severity are discarded',
    'Inside a finding',
  ]) {
    assert.ok(!p.includes(findingOnly), `refactor-only prompt still asks for: ${findingOnly}`);
  }

  // What is not about a finding's shape stays, and the empty-array advice is retargeted.
  assert.match(p, /partial view of the codebase/);
  assert.match(p, /No style, formatting, naming/);
  assert.match(p, /Prefer few high-signal refactors/);
  assert.ok(!p.includes('Prefer few high-signal findings'));
});

test('a run that posts inline comments keeps the finding rules', () => {
  const p = prompt('review', { minSeverity: 'high' });

  for (const rule of ['Anchor every finding', '`confidence`', '`suggestion`', 'severity are discarded']) {
    assert.ok(p.includes(rule), `review prompt lost: ${rule}`);
  }
  assert.ok(!p.includes('Return `findings` as an empty array'));
});

/**
 * The gutter is a contract: the model is told to read line numbers out of it and
 * anchor findings to them. When the documented shape drifts from what parsePatch
 * emits, every finding is anchored against a spec that does not describe the
 * input, so this asserts the example is the renderer's real output.
 */
test('the documented gutter matches what parsePatch actually renders', () => {
  const { annotated } = parsePatch(
    ['@@ -40,3 +42,4 @@', '+  const x = compute();', '   return x;', '-  const y = old();'].join('\n'),
  );

  const p = prompt();
  for (const line of annotated.split('\n')) {
    assert.ok(p.includes(line), `prompt does not document this rendering: ${JSON.stringify(line)}`);
  }
});

test('the prompt explains that line numbers jump over code it cannot see', () => {
  const p = prompt();

  // The hunk header appears in every real diff, so it has to be in the format spec.
  assert.ok(p.includes('@@ -40,3 +42,4 @@'));
  // The actual anti-hallucination point: a gap is unseen code, not absent code.
  assert.match(p, /exists in the file and is simply not shown/);
  assert.match(p, /undefined, uninitialised, unused, or never called/);
});

test('the discard thresholds quoted to the model are the ones the run filters on', () => {
  const strict = prompt('review', { minConfidence: 0.85, minSeverity: 'high' });
  assert.ok(strict.includes('below 0.85 is discarded'));
  assert.ok(strict.includes('below `high` severity are discarded'));

  // A stale hardcoded 0.6 would calibrate the model against the wrong bar.
  assert.ok(!strict.includes('below 0.6'));
});

test('the severity floor is left out when nothing is filtered by it', () => {
  assert.ok(!prompt('review', { minSeverity: 'low' }).includes('severity are discarded'));
});

/**
 * The thresholds above say what is too weak to send. This is the other end of the
 * same argument: a finding that clears every threshold and is then dropped by the
 * cap was still worked up in full first. On a model that spends most of its output
 * budget deliberating, that is the expensive half paid for a comment nobody reads.
 */
test('the run names the cap on how many findings survive it', () => {
  const p = prompt('review', { maxComments: 4 });

  assert.match(p, /At most 4 finding\(s\) are posted on this run/);
  assert.match(p, /taken in order of severity and then/);
  // The number has to follow the config, the way the thresholds above do.
  assert.ok(!p.includes('At most 15 finding(s)'));
});

test('the issue cap is quoted to a run that opens issues, and to no other', () => {
  assert.match(prompt('refactor', { maxIssues: 2 }), /At most\s+2 issue\(s\) are opened on this run/);
  assert.ok(!prompt('review').includes('issue(s) are opened on this run'));
});

const target = { owner: 'o', repo: 'r', headSha: 'sha', title: 'T', description: 'D' } as Target;

const reviewed: DiffFile[] = [
  {
    path: 'src/a.ts',
    status: 'modified',
    additions: 1,
    deletions: 0,
    patch: '',
    commentableLines: new Set([1]),
    annotated: '    1 +const a = 1;',
  },
];

const userPrompt = (omitted: string[], priors: PriorDefinition[] = []) =>
  buildUserPrompt(target, reviewed, 0, 1, omitted, priors);

const prior = (over: Partial<PriorDefinition> = {}): PriorDefinition => ({
  name: 'parseCard',
  path: 'apps/console/src/lib/cards.ts',
  line: 42,
  text: 'export function parseCard(raw: string): Card {',
  ...over,
});

test('the user prompt names the changed files it is not showing', () => {
  // Without this the model sees a use with no definition anywhere in its input.
  const p = userPrompt(['src/generated/api.ts', 'assets/logo.png']);

  assert.match(p, /# Changed but not shown/);
  assert.ok(p.includes('- src/generated/api.ts'));
  assert.ok(p.includes('- assets/logo.png'));
  assert.match(p, /Do not report a symbol as missing, undefined, or never used/);
});

test('the withheld list is capped so a wide change cannot flood the prompt', () => {
  const p = userPrompt(Array.from({ length: 50 }, (_, i) => `src/f${i}.ts`));

  assert.ok(p.includes('- src/f0.ts'));
  assert.ok(!p.includes('- src/f49.ts'));
  assert.match(p, /and 30 more/);
});

test('nothing is said about withheld files when the whole change was reviewed', () => {
  assert.ok(!userPrompt([]).includes('Changed but not shown'));
});

test('a retrieved definition is shown with where it lives and what it says', () => {
  // The whole point of the retrieval: the reuse check stops being a question the
  // reviewer has to speculate about and becomes one it can read the answer to.
  const p = userPrompt([], [prior()]);

  assert.match(p, /# Already in this repository/);
  assert.ok(p.includes('- `parseCard` — also defined at apps/console/src/lib/cards.ts:42'));
  assert.ok(p.includes('    export function parseCard(raw: string): Card {'));
});

test('the reviewer is told that sharing a name is not the same as being the same thing', () => {
  // Without this the retrieved list reads as a list of findings to write up.
  const p = userPrompt([], [prior()]);

  assert.match(p, /two different things that happen to share a name is not/i);
  assert.match(p, /`reuse:` finding/);
});

test('nothing is said about prior definitions when the search found none', () => {
  assert.ok(!userPrompt([]).includes('Already in this repository'));
  assert.ok(!userPrompt(['src/x.ts']).includes('Already in this repository'));
});

test('the retrieved list is capped by count so it cannot crowd out the diff', () => {
  const many = Array.from({ length: 40 }, (_, i) => prior({ name: `name${i}` }));
  const p = userPrompt([], many);

  assert.ok(p.includes('`name0`'));
  assert.ok(!p.includes('`name39`'), 'the list ran past its cap');
  assert.match(p, /- \.\.\. and 20 more/);
});

test('the retrieved list is capped by size as well as by count', () => {
  // Twenty short names fit; twenty long ones are what would actually crowd the
  // batch, so the character budget has to bite before the count does.
  const long = Array.from({ length: 20 }, (_, i) =>
    prior({ name: `name${i}`, text: `export function name${i}(${'arg: string, '.repeat(40)}) {` }),
  );
  const p = userPrompt([], long);

  assert.ok(p.includes('`name0`'));
  assert.ok(!p.includes('`name19`'), 'the character cap did not bite');
  assert.match(p, /- \.\.\. and \d+ more/);
});

test('the no-restating rule exempts the summary field it does not govern', () => {
  const p = prompt();
  // The schema requires `summary` to describe the change, so an unqualified "no
  // summary of what the code does" contradicted a mandatory field.
  assert.match(p, /Inside a finding/);
  assert.match(p, /top-level `summary` field is the one place that describes the change/);
});
