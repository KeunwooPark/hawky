import assert from 'node:assert/strict';
import { test } from 'node:test';
import { buildSystemPrompt, buildUserPrompt } from '../src/prompts.js';
import { parsePatch } from '../src/gh/diff.js';
import type { Config, Mode, Ponytail } from '../src/config.js';
import type { Target } from '../src/gh/client.js';
import type { DiffFile } from '../src/types.js';

const prompt = (ponytail: Ponytail, mode: Mode = 'review', over: Partial<Config> = {}) =>
  buildSystemPrompt(
    {
      guidelines: '',
      ponytail,
      minConfidence: 0.6,
      minSeverity: 'medium',
      maxComments: 15,
      maxIssues: 3,
      ...over,
    } as Config,
    mode,
  );

test('the over-engineering pass is absent unless ponytail is switched on', () => {
  const off = prompt('off');
  assert.ok(!off.includes('## Over-engineering'));
  // Nothing about the ladder should leak into a review that did not ask for it.
  assert.ok(!off.includes('YAGNI'));
  assert.ok(!off.includes('over-engineering'));
});

test('ponytail adds the ladder, the tags, and the severity ceiling', () => {
  const p = prompt('full');

  assert.ok(p.includes('## Over-engineering'));
  assert.ok(p.includes('YAGNI'));
  for (const tag of ['`delete:`', '`stdlib:`', '`native:`', '`yagni:`', '`shrink:`']) {
    assert.ok(p.includes(tag), `missing tag ${tag}`);
  }
  assert.ok(p.includes('`category` set to `over-engineering`'));

  // The gate reads severity, so the model has to be told these never reach it.
  assert.match(p, /never `high` or `critical`/);
});

test('ponytail never asks for the simplifications that are not safe to make', () => {
  const p = prompt('full');
  for (const guard of ['trust boundary', 'data loss', 'security measure', 'accessibility']) {
    assert.ok(p.includes(guard), `missing guard: ${guard}`);
  }
  // Deleting code is in scope; opinions about how it is written are not.
  assert.ok(p.includes('The no-style rule above still holds.'));
});

test('each intensity says something different about how much to cut', () => {
  const [lite, full, ultra] = (['lite', 'full', 'ultra'] as const).map((l) => prompt(l));

  assert.match(lite, /Intensity: lite\./);
  assert.match(full, /Intensity: full\./);
  assert.match(ultra, /Intensity: ultra\./);
  assert.notEqual(lite, full);
  assert.notEqual(full, ultra);

  // lite defers to the author; ultra argues the code should not exist.
  assert.match(lite, /The author decides/);
  assert.match(ultra, /needs to exist at all/);
});

test('refactor-only runs get the ladder without the inline-finding instructions', () => {
  const p = prompt('full', 'refactor');

  assert.ok(p.includes('## Over-engineering'));
  // There are no inline comments in this mode, so the tag vocabulary is noise.
  assert.ok(!p.includes('`stdlib:`'));
  assert.ok(p.includes('A refactor that deletes a layer beats one'));
});

test('a review-only run says nothing about refactors deleting layers', () => {
  assert.ok(!prompt('full', 'review').includes('deletes a layer'));
});

test('refactor-only runs are told to leave the required findings array empty', () => {
  // The schema requires `findings` in every mode and this one discards whatever
  // comes back in it, so an unexplained mandatory field is output nobody reads.
  const p = prompt('full', 'refactor');

  assert.match(p, /Return `findings` as an empty array/);
  assert.match(p, /put everything you have to say in `refactors` and `summary`/);
});

test('refactor-only runs drop the rules about fields only a finding has', () => {
  const p = prompt('full', 'refactor', { minSeverity: 'high' });

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
  const p = prompt('full', 'review', { minSeverity: 'high' });

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

  const p = prompt('off');
  for (const line of annotated.split('\n')) {
    assert.ok(p.includes(line), `prompt does not document this rendering: ${JSON.stringify(line)}`);
  }
});

test('the prompt explains that line numbers jump over code it cannot see', () => {
  const p = prompt('off');

  // The hunk header appears in every real diff, so it has to be in the format spec.
  assert.ok(p.includes('@@ -40,3 +42,4 @@'));
  // The actual anti-hallucination point: a gap is unseen code, not absent code.
  assert.match(p, /exists in the file and is simply not shown/);
  assert.match(p, /undefined, uninitialised, unused, or never called/);
});

test('the discard thresholds quoted to the model are the ones the run filters on', () => {
  const strict = prompt('off', 'review', { minConfidence: 0.85, minSeverity: 'high' });
  assert.ok(strict.includes('below 0.85 is discarded'));
  assert.ok(strict.includes('below `high` severity are discarded'));

  // A stale hardcoded 0.6 would calibrate the model against the wrong bar.
  assert.ok(!strict.includes('below 0.6'));
});

test('the severity floor is left out when nothing is filtered by it', () => {
  assert.ok(!prompt('off', 'review', { minSeverity: 'low' }).includes('severity are discarded'));
});

/**
 * The thresholds above say what is too weak to send. This is the other end of the
 * same argument: a finding that clears every threshold and is then dropped by the
 * cap was still worked up in full first. On a model that spends most of its output
 * budget deliberating, that is the expensive half paid for a comment nobody reads.
 */
test('the run names the cap on how many findings survive it', () => {
  const p = prompt('off', 'review', { maxComments: 4 });

  assert.match(p, /At most 4 finding\(s\) are posted on this run/);
  assert.match(p, /taken in order of severity and then/);
  // The number has to follow the config, the way the thresholds above do.
  assert.ok(!p.includes('At most 15 finding(s)'));
});

test('the issue cap is quoted to a run that opens issues, and to no other', () => {
  assert.match(prompt('off', 'refactor', { maxIssues: 2 }), /At most\s+2 issue\(s\) are opened on this run/);
  assert.ok(!prompt('off', 'review').includes('issue(s) are opened on this run'));
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

const userPrompt = (omitted: string[]) => buildUserPrompt(target, reviewed, 0, 1, omitted);

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

test('the no-restating rule exempts the summary field it does not govern', () => {
  const p = prompt('off');
  // The schema requires `summary` to describe the change, so an unqualified "no
  // summary of what the code does" contradicted a mandatory field.
  assert.match(p, /Inside a finding/);
  assert.match(p, /top-level `summary` field is the one place that describes the change/);
});
