import * as core from '@actions/core';
import { minimatch } from 'minimatch';
import type { Config } from '../config.js';
import type { Diff, DiffFile } from '../types.js';
import type { Octokit } from './client.js';

/**
 * Parse a unified diff hunk-by-hunk, tracking head-revision line numbers.
 *
 * GitHub rejects an entire review with 422 if any comment anchors to a line
 * that is not part of the diff, so we record exactly which head lines are
 * addressable (added and context lines) and validate against that set later.
 *
 * `lines` carries the text of each of those lines, keyed the same way. It is what
 * lets a later check compare a proposed replacement with the code it would
 * replace — the same walk already has both, and deriving it a second time
 * elsewhere would be the same hunk arithmetic written twice.
 */
export function parsePatch(patch: string): {
  commentableLines: Set<number>;
  annotated: string;
  lines: Map<number, string>;
} {
  const commentableLines = new Set<number>();
  const lines = new Map<number, string>();
  const out: string[] = [];
  let headLine = 0;

  for (const raw of patch.split('\n')) {
    if (raw.startsWith('@@')) {
      const m = /^@@ -\d+(?:,\d+)? \+(\d+)(?:,\d+)? @@/.exec(raw);
      headLine = m ? Number(m[1]) : headLine;
      out.push(`      ${raw}`);
      continue;
    }
    if (raw.startsWith('+')) {
      commentableLines.add(headLine);
      lines.set(headLine, raw.slice(1));
      out.push(`${String(headLine).padStart(5)} +${raw.slice(1)}`);
      headLine++;
    } else if (raw.startsWith('-')) {
      out.push(`    - ${raw.slice(1)}`);
    } else if (raw.startsWith('\\')) {
      out.push(`      ${raw}`);
    } else {
      // Context line: addressable, but we tell the model not to comment on it.
      commentableLines.add(headLine);
      lines.set(headLine, raw.slice(1));
      out.push(`${String(headLine).padStart(5)}  ${raw.slice(1)}`);
      headLine++;
    }
  }

  return { commentableLines, annotated: out.join('\n'), lines };
}

/**
 * Why this path is not being reviewed, or null when it is.
 *
 * The reason rather than a boolean so the run log can answer the question a
 * filtered — or an unexpectedly unfiltered — file raises: which glob did this,
 * and did the configuration carrying it reach the run at all.
 */
function skipReason(path: string, cfg: Config): string | null {
  if (cfg.include.length && !cfg.include.some((g) => minimatch(path, g, { dot: true }))) {
    return 'no include glob matches it';
  }
  const glob = cfg.exclude.find((g) => minimatch(path, g, { dot: true }));
  return glob ? `it matches exclude "${glob}"` : null;
}

function toDiffFiles(
  files: Array<{
    filename: string;
    previous_filename?: string;
    status: string;
    additions: number;
    deletions: number;
    patch?: string;
  }>,
  cfg: Config,
): Diff {
  const kept: DiffFile[] = [];
  const omitted: string[] = [];

  for (const f of files) {
    // No `patch` means binary or too large for the API to render.
    if (!f.patch || f.status === 'removed' || f.additions === 0) {
      omitted.push(f.filename);
      continue;
    }
    const skipped = skipReason(f.filename, cfg);
    if (skipped) {
      core.debug(`Not reviewing ${f.filename}: ${skipped}.`);
      omitted.push(f.filename);
      continue;
    }
    const { commentableLines, annotated } = parsePatch(f.patch);
    kept.push({
      path: f.filename,
      previousPath: f.previous_filename,
      status: f.status,
      additions: f.additions,
      deletions: f.deletions,
      patch: f.patch,
      commentableLines,
      annotated,
    });
  }

  core.info(`Diff: ${kept.length} file(s) to review, ${omitted.length} skipped (binary, deleted, or filtered).`);

  // Review the smallest files first so a maxFiles cut keeps the most files.
  kept.sort((a, b) => a.annotated.length - b.annotated.length);
  if (kept.length > cfg.maxFiles) {
    core.warning(`Reviewing the first ${cfg.maxFiles} of ${kept.length} changed files (max_files).`);
    return {
      files: kept.slice(0, cfg.maxFiles),
      omitted: [...omitted, ...kept.slice(cfg.maxFiles).map((f) => f.path)],
    };
  }
  return { files: kept, omitted };
}

export async function getPullRequestDiff(
  octokit: Octokit,
  owner: string,
  repo: string,
  pull_number: number,
  cfg: Config,
): Promise<Diff> {
  const files = await octokit.paginate(octokit.rest.pulls.listFiles, {
    owner,
    repo,
    pull_number,
    per_page: 100,
  });
  return toDiffFiles(files, cfg);
}

export async function getCompareDiff(
  octokit: Octokit,
  owner: string,
  repo: string,
  base: string,
  head: string,
  cfg: Config,
): Promise<Diff> {
  const { data } = await octokit.rest.repos.compareCommitsWithBasehead({
    owner,
    repo,
    basehead: `${base}...${head}`,
  });
  return toDiffFiles(data.files ?? [], cfg);
}

/**
 * Shrink one oversized file's diff so it fits a batch.
 *
 * Cutting the rendered text at an arbitrary character leaves a severed line, and
 * half a statement reads as a defect: the model reports the missing half rather
 * than the truncation. So the cut lands on a line boundary and the kept lines are
 * re-rendered from the patch, which is also what keeps `commentableLines` honest.
 * Carried over untouched it would still list lines that were cut away, and
 * anchoring a comment to one of those makes GitHub reject the whole review.
 */
function truncateFile(file: DiffFile, maxChars: number): DiffFile {
  // What parsePatch prepends to every line: a five-wide gutter and a marker column.
  const GUTTER = 7;
  const lines = file.patch.split('\n');
  const kept: string[] = [];
  let size = 0;

  for (const line of lines) {
    // Always keep one line, or a budget smaller than the first line yields no diff at all.
    if (kept.length && size + line.length + GUTTER > maxChars) break;
    kept.push(line);
    size += line.length + GUTTER;
  }

  const omitted = lines.length - kept.length;
  const { commentableLines, annotated } = parsePatch(kept.join('\n'));
  return {
    ...file,
    commentableLines,
    annotated:
      `${annotated}\n\n` +
      `... ${omitted} more diff line(s) in this file are not shown (too large to review in full); ` +
      'the code they contain exists ...',
  };
}

/** Pack files into batches that fit a single LLM call. */
export function batchFiles(files: DiffFile[], maxChars: number): DiffFile[][] {
  const batches: DiffFile[][] = [];
  let current: DiffFile[] = [];
  let size = 0;

  for (const raw of files) {
    // A single file can exceed the batch budget; truncate rather than blow the context window.
    const file = raw.annotated.length > maxChars ? truncateFile(raw, maxChars) : raw;
    const cost = file.annotated.length + file.path.length + 64;
    if (current.length && size + cost > maxChars) {
      batches.push(current);
      current = [];
      size = 0;
    }
    current.push(file);
    size += cost;
  }
  if (current.length) batches.push(current);
  return batches;
}
