/**
 * What the change defines that the repository already defines somewhere else.
 *
 * The reviewer sees `pulls.listFiles` output and nothing else, so "is it already
 * in this codebase?" — the reuse check, and the one a diff-only reviewer is worst
 * at — was a question with no evidence available to settle it. A model told that
 * anything failing the check is worth reporting, and handed no way to answer it,
 * does not converge: three production runs spent 97-98% of all output tokens
 * reasoning.
 *
 * So the answer is retrieved before the call rather than during it. No tool loop,
 * no second generation, no giving up single-shot structured output: hawky reads
 * the names the diff defines, looks them up in the checked-out tree, and puts what
 * it finds in the user prompt. Speculation is replaced with facts, and facts are
 * cheaper to think about.
 *
 * Name matching finds a name defined twice. It does not find twenty lines
 * reimplementing `chunk()` under another name, which needs structural or embedding
 * similarity and is a much larger piece of work. This is the cheap half.
 */
import * as fs from 'node:fs';
import * as path from 'node:path';
import * as core from '@actions/core';
import { minimatch } from 'minimatch';
import type { DiffFile, PriorDefinition } from '../types.js';

/**
 * Definition patterns, keyed by extension. Every one is anchored to the start of
 * the line, so only top-level definitions are indexed.
 *
 * That is deliberate rather than lazy. An indented `const` is a local, and a
 * method named `parse` on one class is not a reimplementation of `parse` on
 * another — matching either produces a retrieved "prior definition" for something
 * nobody reused, which costs prompt and invites the model to adjudicate noise.
 * Missing a helper method is the cheaper error.
 */
const TS_PATTERNS: RegExp[] = [
  /^(?:export\s+(?:default\s+)?)?(?:async\s+)?function\s+\*?([A-Za-z_$][\w$]*)/,
  /^(?:export\s+(?:default\s+)?)?(?:abstract\s+)?class\s+([A-Za-z_$][\w$]*)/,
  /^(?:export\s+)?(?:const|let)\s+([A-Za-z_$][\w$]*)\s*[=:]/,
  /^(?:export\s+)?type\s+([A-Za-z_$][\w$]*)\s*[=<]/,
  /^(?:export\s+)?interface\s+([A-Za-z_$][\w$]*)/,
];

const PY_PATTERNS: RegExp[] = [
  /^(?:async\s+)?def\s+([A-Za-z_]\w*)/,
  /^class\s+([A-Za-z_]\w*)/,
];

const PATTERNS_BY_EXTENSION: Record<string, RegExp[]> = {
  '.ts': TS_PATTERNS,
  '.tsx': TS_PATTERNS,
  '.mts': TS_PATTERNS,
  '.cts': TS_PATTERNS,
  '.js': TS_PATTERNS,
  '.jsx': TS_PATTERNS,
  '.mjs': TS_PATTERNS,
  '.cjs': TS_PATTERNS,
  '.py': PY_PATTERNS,
  '.pyi': PY_PATTERNS,
};

/** Past this, a "source file" is generated or vendored and not worth reading. */
const MAX_FILE_BYTES = 256 * 1024;

/** A ceiling on the scan, so an enormous monorepo cannot stall the run. */
const MAX_FILES_SCANNED = 5_000;

/**
 * A name shorter than this is `x`, `id`, `ok` — shared by accident rather than by
 * duplication, and pure noise when two files both happen to use it.
 */
const MIN_NAME_LENGTH = 3;

/** One definition found in the checked-out tree. */
interface Definition {
  name: string;
  path: string;
  line: number;
  text: string;
}

export interface RepoIndex {
  /** Normalised name -> every top-level definition of it in the tree. */
  readonly definitions: Map<string, Definition[]>;
  readonly filesScanned: number;
}

/**
 * `parse_card` and `parseCard` are the same helper written in two house styles,
 * which is exactly the duplication worth catching across a polyglot repository.
 */
function normalise(name: string): string {
  return name.replace(/[_-]/g, '').toLowerCase();
}

function definitionsIn(text: string, patterns: RegExp[], filePath: string): Definition[] {
  const found: Definition[] = [];
  const lines = text.split('\n');

  for (let i = 0; i < lines.length; i++) {
    const line = lines[i];
    // Cheap rejection before running five regexes: every pattern here needs a
    // keyword in the first token, and most lines in a file are indented.
    if (!line || line[0] === ' ' || line[0] === '\t') continue;
    for (const pattern of patterns) {
      const name = pattern.exec(line)?.[1];
      if (name && name.length >= MIN_NAME_LENGTH) {
        found.push({ name, path: filePath, line: i + 1, text: line.trim() });
        break;
      }
    }
  }
  return found;
}

/**
 * Whether a directory can be skipped whole.
 *
 * Asked by testing a hypothetical file inside it against the configured globs:
 * `node_modules/**` and `dist/**` match `node_modules/x.ts` and `dist/x.ts`, while
 * a glob like `**\/*.lock` matches neither and correctly prunes nothing. Walking
 * into `node_modules` would otherwise spend the whole file budget on dependencies
 * that are then excluded one by one.
 */
function prunes(relDir: string, exclude: string[]): boolean {
  if (relDir === '.git' || relDir.endsWith('/.git')) return true;
  const probe = `${relDir}/hawky-probe.ts`;
  return exclude.some((glob) => minimatch(probe, glob, { dot: true }));
}

/**
 * Read every indexable file in the checked-out tree.
 *
 * Returns null when there is nothing to search, which is the case this has to get
 * right: "No checkout step is needed" is the first promise the README makes, so a
 * workflow with no `actions/checkout` must keep reviewing exactly as it did — not
 * fail, and not silently pretend the reuse check ran.
 */
export function buildRepoIndex(root: string, exclude: string[]): RepoIndex | null {
  const definitions = new Map<string, Definition[]>();
  let filesScanned = 0;

  const walk = (dir: string): void => {
    if (filesScanned >= MAX_FILES_SCANNED) return;
    let entries: fs.Dirent[];
    try {
      entries = fs.readdirSync(dir, { withFileTypes: true });
    } catch {
      // An unreadable directory is not worth failing a review over.
      return;
    }

    for (const entry of entries) {
      if (filesScanned >= MAX_FILES_SCANNED) return;
      const full = path.join(dir, entry.name);
      const rel = path.relative(root, full).split(path.sep).join('/');

      if (entry.isDirectory()) {
        if (!prunes(rel, exclude)) walk(full);
        continue;
      }
      if (!entry.isFile()) continue;

      const patterns = PATTERNS_BY_EXTENSION[path.extname(entry.name).toLowerCase()];
      if (!patterns) continue;
      if (exclude.some((glob) => minimatch(rel, glob, { dot: true }))) continue;

      try {
        if (fs.statSync(full).size > MAX_FILE_BYTES) continue;
        filesScanned++;
        for (const def of definitionsIn(fs.readFileSync(full, 'utf8'), patterns, rel)) {
          const key = normalise(def.name);
          const existing = definitions.get(key);
          if (existing) existing.push(def);
          else definitions.set(key, [def]);
        }
      } catch {
        continue;
      }
    }
  };

  if (!fs.existsSync(root)) return null;
  walk(root);
  return filesScanned ? { definitions, filesScanned } : null;
}

/** The names a batch's added lines define, in the order the diff defines them. */
function namesAddedBy(file: DiffFile): string[] {
  const patterns = PATTERNS_BY_EXTENSION[path.extname(file.path).toLowerCase()];
  if (!patterns) return [];

  const added = file.patch
    .split('\n')
    .filter((line) => line.startsWith('+') && !line.startsWith('+++'))
    .map((line) => line.slice(1))
    .join('\n');

  return definitionsIn(added, patterns, file.path).map((d) => d.name);
}

/**
 * Names this batch defines that the repository already defines somewhere else.
 *
 * The checkout is the head revision, so every name the diff adds is also in the
 * index at the path that added it. A definition at the diff's own path is
 * therefore the change itself, not a prior one, and is dropped.
 */
export function findPriorDefinitions(index: RepoIndex, files: DiffFile[]): PriorDefinition[] {
  const priors: PriorDefinition[] = [];
  const seen = new Set<string>();

  for (const file of files) {
    const ownPaths = new Set([file.path, file.previousPath].filter(Boolean) as string[]);
    for (const name of namesAddedBy(file)) {
      const key = normalise(name);
      if (seen.has(key)) continue;
      const elsewhere = index.definitions.get(key)?.find((d) => !ownPaths.has(d.path));
      if (!elsewhere) continue;
      seen.add(key);
      priors.push({ name, path: elsewhere.path, line: elsewhere.line, text: elsewhere.text });
    }
  }
  return priors;
}

/** One line for the run log, so a review that used retrieval says that it did. */
export function describeIndex(index: RepoIndex): string {
  return `Indexed ${index.definitions.size.toLocaleString()} top-level name(s) across ${index.filesScanned.toLocaleString()} file(s) for the reuse check.`;
}

/** What to say when the reuse check was asked for and there is no tree to search. */
export function warnNoCheckout(): void {
  core.warning(
    'codebase-context is on, but there is no checked-out repository to search, so the reuse check has ' +
      'only the diff to go on. Add `actions/checkout` to this job to let Hawky see what the change may be ' +
      're-implementing, or set `codebase-context: false` to silence this.',
  );
}
