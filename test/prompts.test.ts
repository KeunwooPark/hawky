import assert from 'node:assert/strict';
import { test } from 'node:test';
import { buildSystemPrompt } from '../src/prompts.js';
import type { Config, Mode, Ponytail } from '../src/config.js';

const prompt = (ponytail: Ponytail, mode: Mode = 'review') =>
  buildSystemPrompt({ guidelines: '', ponytail } as Config, mode);

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
