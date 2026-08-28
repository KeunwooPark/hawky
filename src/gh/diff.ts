import * as core from '@actions/core';
import { minimatch } from 'minimatch';
import type { Config } from '../config.js';
import type { DiffFile } from '../types.js';
import type { Octokit } from './client.js';

/**
 * Parse a unified diff hunk-by-hunk, tracking head-revision line numbers.
 *
 * GitHub rejects an entire review with 422 if any comment anchors to a line
 * that is not part of the diff, so we record exactly which head lines are
 * addressable (added and context lines) and validate against that set later.
 */
export function parsePatch(patch: string): { commentableLines: Set<number>; annotated: string } {
  const commentableLines = new Set<number>();
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
      out.push(`${String(headLine).padStart(5)} +${raw.slice(1)}`);
      headLine++;
    } else if (raw.startsWith('-')) {
      out.push(`    - ${raw.slice(1)}`);
    } else if (raw.startsWith('\\')) {
      out.push(`      ${raw}`);
    } else {
      // Context line: addressable, but we tell the model not to comment on it.
      commentableLines.add(headLine);
      out.push(`${String(headLine).padStart(5)}  ${raw.slice(1)}`);
      headLine++;
    }
  }

  return { commentableLines, annotated: out.join('\n') };
}

function isExcluded(path: string, cfg: Config): boolean {
  if (cfg.include.length && !cfg.include.some((g) => minimatch(path, g, { dot: true }))) {
    return true;
  }
  return cfg.exclude.some((g) => minimatch(path, g, { dot: true }));
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
): DiffFile[] {
  const kept: DiffFile[] = [];
  let skipped = 0;

  for (const f of files) {
    // No `patch` means binary or too large for the API to render.
    if (!f.patch || f.status === 'removed' || f.additions === 0) {
      skipped++;
      continue;
    }
    if (isExcluded(f.filename, cfg)) {
      skipped++;
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

  core.info(`Diff: ${kept.length} file(s) to review, ${skipped} skipped (binary, deleted, or filtered).`);

  // Review the smallest files first so a maxFiles cut keeps the most files.
  kept.sort((a, b) => a.annotated.length - b.annotated.length);
  if (kept.length > cfg.maxFiles) {
    core.warning(`Reviewing the first ${cfg.maxFiles} of ${kept.length} changed files (max_files).`);
    return kept.slice(0, cfg.maxFiles);
  }
  return kept;
}

export async function getPullRequestDiff(
  octokit: Octokit,
  owner: string,
  repo: string,
  pull_number: number,
  cfg: Config,
): Promise<DiffFile[]> {
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
): Promise<DiffFile[]> {
  const { data } = await octokit.rest.repos.compareCommitsWithBasehead({
    owner,
    repo,
    basehead: `${base}...${head}`,
  });
  return toDiffFiles(data.files ?? [], cfg);
}

/** Pack files into batches that fit a single LLM call. */
export function batchFiles(files: DiffFile[], maxChars: number): DiffFile[][] {
  const batches: DiffFile[][] = [];
  let current: DiffFile[] = [];
  let size = 0;

  for (const raw of files) {
    // A single file can exceed the batch budget; truncate rather than blow the context window.
    const file =
      raw.annotated.length > maxChars
        ? {
            ...raw,
            annotated: `${raw.annotated.slice(0, maxChars)}\n      ... diff truncated (file too large to review in full) ...`,
          }
        : raw;
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
