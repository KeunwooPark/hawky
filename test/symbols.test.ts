import assert from 'node:assert/strict';
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import { afterEach, test } from 'node:test';
import { buildRepoIndex, findPriorDefinitions } from '../src/repo/symbols.js';
import type { DiffFile } from '../src/types.js';

const roots: string[] = [];

afterEach(() => {
  for (const root of roots.splice(0)) fs.rmSync(root, { recursive: true, force: true });
});

/** A throwaway checkout, so the scan is exercised against real files. */
function tree(files: Record<string, string>): string {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'hawky-repo-'));
  roots.push(root);
  for (const [rel, body] of Object.entries(files)) {
    const abs = path.join(root, rel);
    fs.mkdirSync(path.dirname(abs), { recursive: true });
    fs.writeFileSync(abs, body);
  }
  return root;
}

function added(filePath: string, lines: string[], previousPath?: string): DiffFile {
  return {
    path: filePath,
    previousPath,
    status: 'modified',
    additions: lines.length,
    deletions: 0,
    patch: [`@@ -1,0 +1,${lines.length} @@`, ...lines.map((l) => `+${l}`)].join('\n'),
    commentableLines: new Set(),
    annotated: '',
  };
}

/** Index a tree and match a diff against it in one step, as the run does. */
function priorsFor(files: Record<string, string>, diff: DiffFile[], exclude: string[] = []) {
  const index = buildRepoIndex(tree(files), exclude);
  return index ? findPriorDefinitions(index, diff) : null;
}

test('a name the change adds is retrieved from where the repository already defines it', () => {
  const priors = priorsFor(
    { 'lib/cards.ts': 'export function parseCard(raw: string): Card {\n  return JSON.parse(raw);\n}\n' },
    [added('src/new.ts', ['export function parseCard(raw: string) {', '  return JSON.parse(raw);', '}'])],
  );

  assert.deepEqual(priors, [
    {
      name: 'parseCard',
      path: 'lib/cards.ts',
      line: 1,
      text: 'export function parseCard(raw: string): Card {',
    },
  ]);
});

test('a name written in another house style is still the same helper', () => {
  // The duplication worth catching across a polyglot repository: one team's
  // `parse_card` and another's `parseCard` are the same function twice.
  const priors = priorsFor(
    { 'lib/cards.py': 'def parse_card(raw):\n    return json.loads(raw)\n' },
    [added('src/new.ts', ['export function parseCard(raw: string) {'])],
  );

  assert.equal(priors?.length, 1);
  assert.equal(priors?.[0].name, 'parseCard');
  assert.equal(priors?.[0].path, 'lib/cards.py');
});

test('the change is not reported as a prior definition of itself', () => {
  // The checkout is the head revision, so everything the diff adds is already in
  // the tree at the path that added it. Left in, every new function in the change
  // would be retrieved as its own duplicate.
  const priors = priorsFor(
    { 'src/new.ts': 'export function parseCard(raw: string) {\n  return 1;\n}\n' },
    [added('src/new.ts', ['export function parseCard(raw: string) {'])],
  );

  assert.deepEqual(priors, []);
});

test('a renamed file is not a prior definition of its own code either', () => {
  const priors = priorsFor(
    { 'src/new.ts': 'export function parseCard(raw: string) {\n}\n' },
    [added('src/new.ts', ['export function parseCard(raw: string) {'], 'src/old.ts')],
  );

  assert.deepEqual(priors, []);
});

test('excluded paths are not searched', () => {
  // A vendored or generated copy is not a reuse opportunity, and `dist/**` is
  // excluded by default precisely because it is the same code again.
  const files = {
    'dist/bundle.ts': 'export function parseCard(raw) {}\n',
    'src/keep.ts': 'export const unrelated = 1;\n',
  };
  const diff = [added('src/new.ts', ['export function parseCard(raw: string) {'])];

  assert.deepEqual(priorsFor(files, diff, ['dist/**']), []);
  // Without the exclusion the same tree does find it, so the glob is what did it.
  assert.equal(priorsFor(files, diff, [])?.length, 1);
});

test('a local inside a function is not a definition the repository offers', () => {
  // Only top-level definitions are indexed. An indented `const` is a local, and
  // matching it retrieves a "prior definition" nobody could reuse.
  const priors = priorsFor(
    { 'src/other.ts': 'export function outer() {\n  const helper = () => 1;\n  return helper;\n}\n' },
    [added('src/new.ts', ['export const helper = () => 2;'])],
  );

  assert.deepEqual(priors, []);
});

test('names too short to mean anything are left alone', () => {
  // `id` in two files is a coincidence, not duplication.
  const priors = priorsFor(
    { 'src/other.ts': 'export const id = 1;\n' },
    [added('src/new.ts', ['export const id = 2;'])],
  );

  assert.deepEqual(priors, []);
});

test('each name is retrieved once however many times the batch defines it', () => {
  const priors = priorsFor(
    { 'lib/cards.ts': 'export function parseCard(raw: string) {}\n' },
    [
      added('src/a.ts', ['export function parseCard(raw: string) {']),
      added('src/b.ts', ['export function parse_card(raw: string) {']),
    ],
  );

  assert.equal(priors?.length, 1);
});

test('a workspace with nothing to search is not an index', () => {
  // The case the default has to get right: a workflow with no `actions/checkout`
  // keeps reviewing exactly as it did, rather than failing or pretending to scan.
  assert.equal(buildRepoIndex(tree({}), []), null);
  assert.equal(buildRepoIndex(path.join(os.tmpdir(), 'hawky-does-not-exist'), []), null);
  // A tree of files in languages this does not parse is the same situation.
  assert.equal(buildRepoIndex(tree({ 'main.rb': 'def parse_card\nend\n' }), []), null);
});

test('a file in a language the table does not cover contributes no names', () => {
  const priors = priorsFor(
    { 'src/keep.ts': 'export const unrelated = 1;\n' },
    [added('main.rb', ['def parse_card'])],
  );

  assert.deepEqual(priors, []);
});

test('an oversized file is skipped rather than read into the index', () => {
  const huge = `export function parseCard(raw) {}\n// ${'x'.repeat(300 * 1024)}\n`;
  const priors = priorsFor(
    { 'lib/huge.ts': huge, 'src/keep.ts': 'export const unrelated = 1;\n' },
    [added('src/new.ts', ['export function parseCard(raw: string) {'])],
  );

  assert.deepEqual(priors, []);
});

test('classes, types and interfaces count as definitions too', () => {
  const priors = priorsFor(
    {
      'lib/models.ts': 'export interface CardShape {\n  id: string;\n}\n',
      'lib/base.py': 'class CardParser:\n    pass\n',
    },
    [
      added('src/new.ts', ['export type CardShape = {', 'export class CardParser {']),
    ],
  );

  assert.deepEqual(priors?.map((p) => p.name).sort(), ['CardParser', 'CardShape']);
});
