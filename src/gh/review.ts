import * as core from '@actions/core';
import type { Config } from '../config.js';
import { SEVERITY_ORDER, type DiffFile, type Finding, type Severity } from '../types.js';
import { extractFingerprints, findingFingerprint, marker, SUMMARY_MARKER } from '../util/fingerprint.js';
import type { Octokit } from './client.js';

const SEVERITY_LABEL: Record<Severity, string> = {
  critical: 'Critical',
  high: 'High',
  medium: 'Medium',
  low: 'Low',
};

/** A multi-line anchor spanning more than this is almost always a mis-anchor. */
const MAX_ANCHOR_SPAN = 20;

export interface PostedReview {
  posted: Finding[];
  /** Findings whose anchor GitHub would reject; folded into the summary instead. */
  unanchored: Finding[];
  highestSeverity: Severity | null;
}

function severityAtLeast(value: Severity, floor: Severity): boolean {
  return SEVERITY_ORDER[value] >= SEVERITY_ORDER[floor];
}

/**
 * Resolve a finding to a line range GitHub will accept, or null.
 *
 * A review POST fails as a whole with 422 if any single comment anchors outside
 * the diff, so this has to be strict: every line in the range must appear in the
 * patch, which also keeps the range inside one hunk.
 */
export function resolveAnchor(finding: Finding, file: DiffFile): { line: number; startLine?: number } | null {
  const start = finding.line;
  const end = finding.end_line ?? finding.line;
  if (!Number.isInteger(start) || start < 1) return null;
  if (!file.commentableLines.has(start)) return null;

  if (end <= start || end - start > MAX_ANCHOR_SPAN) {
    return { line: start };
  }
  for (let l = start; l <= end; l++) {
    if (!file.commentableLines.has(l)) return { line: start };
  }
  return { line: end, startLine: start };
}

function renderComment(finding: Finding): string {
  const parts = [
    `**${SEVERITY_LABEL[finding.severity]} · ${finding.category}** — ${finding.title}`,
    '',
    finding.body.trim(),
  ];
  if (finding.suggestion && finding.suggestion.trim()) {
    parts.push('', '```suggestion', finding.suggestion.replace(/\s+$/, ''), '```');
  }
  parts.push('', marker('finding', findingFingerprint(finding.path, finding.category, finding.title)));
  return parts.join('\n');
}

function renderSummary(
  summary: string,
  posted: Finding[],
  unanchored: Finding[],
  cfg: Config,
  dropped: number,
): string {
  const lines = [SUMMARY_MARKER, '## Hawky review', '', summary.trim(), ''];

  if (posted.length) {
    const counts = new Map<Severity, number>();
    for (const f of posted) counts.set(f.severity, (counts.get(f.severity) ?? 0) + 1);
    const breakdown = (['critical', 'high', 'medium', 'low'] as Severity[])
      .filter((s) => counts.has(s))
      .map((s) => `${counts.get(s)} ${s}`)
      .join(', ');
    lines.push(`Left ${posted.length} inline comment${posted.length === 1 ? '' : 's'} (${breakdown}).`, '');
  } else {
    lines.push('No new inline comments.', '');
  }

  if (unanchored.length) {
    lines.push(
      '<details><summary>Findings that could not be anchored to a changed line</summary>',
      '',
    );
    for (const f of unanchored) {
      lines.push(
        `- **${f.path}:${f.line}** — ${SEVERITY_LABEL[f.severity]} · ${f.title}`,
        '',
        `  ${f.body.trim().replace(/\n/g, '\n  ')}`,
        '',
      );
    }
    lines.push('</details>', '');
  }

  if (dropped) {
    lines.push(
      `_${dropped} lower-signal finding${dropped === 1 ? '' : 's'} filtered out ` +
        `(below \`${cfg.minSeverity}\` severity or \`${cfg.minConfidence}\` confidence, or already commented on)._`,
      '',
    );
  }

  lines.push(`<sub>Reviewed by ${cfg.provider}/${cfg.model}. Re-run by pushing a commit.</sub>`);
  return lines.join('\n');
}

async function existingFindingFingerprints(
  octokit: Octokit,
  owner: string,
  repo: string,
  pull_number: number,
): Promise<Set<string>> {
  const comments = await octokit.paginate(octokit.rest.pulls.listReviewComments, {
    owner,
    repo,
    pull_number,
    per_page: 100,
  });
  const seen = new Set<string>();
  for (const c of comments) {
    for (const fp of extractFingerprints(c.body, 'finding')) seen.add(fp);
  }
  core.debug(`Found ${seen.size} finding(s) already commented on this PR.`);
  return seen;
}

async function upsertSummary(
  octokit: Octokit,
  owner: string,
  repo: string,
  issue_number: number,
  body: string,
): Promise<void> {
  const comments = await octokit.paginate(octokit.rest.issues.listComments, {
    owner,
    repo,
    issue_number,
    per_page: 100,
  });
  const existing = comments.find((c) => c.body?.includes(SUMMARY_MARKER));

  if (existing) {
    await octokit.rest.issues.updateComment({ owner, repo, comment_id: existing.id, body });
    core.info(`Updated summary comment #${existing.id}.`);
  } else {
    await octokit.rest.issues.createComment({ owner, repo, issue_number, body });
    core.info('Posted summary comment.');
  }
}

export async function postReview(
  octokit: Octokit,
  owner: string,
  repo: string,
  pull_number: number,
  commit_id: string,
  summary: string,
  findings: Finding[],
  files: DiffFile[],
  cfg: Config,
): Promise<PostedReview> {
  const byPath = new Map(files.map((f) => [f.path, f]));
  const alreadyPosted = cfg.dryRun
    ? new Set<string>()
    : await existingFindingFingerprints(octokit, owner, repo, pull_number);

  const before = findings.length;
  const kept = findings
    .filter((f) => byPath.has(f.path))
    .filter((f) => severityAtLeast(f.severity, cfg.minSeverity))
    .filter((f) => (f.confidence ?? 0) >= cfg.minConfidence)
    .filter((f) => !alreadyPosted.has(findingFingerprint(f.path, f.category, f.title)))
    .sort(
      (a, b) =>
        SEVERITY_ORDER[b.severity] - SEVERITY_ORDER[a.severity] || (b.confidence ?? 0) - (a.confidence ?? 0),
    )
    .slice(0, cfg.maxComments);

  const posted: Finding[] = [];
  const unanchored: Finding[] = [];
  const comments: Array<Record<string, unknown>> = [];

  for (const finding of kept) {
    const file = byPath.get(finding.path)!;
    const anchor = resolveAnchor(finding, file);
    if (!anchor) {
      unanchored.push(finding);
      continue;
    }
    posted.push(finding);
    comments.push({
      path: finding.path,
      body: renderComment(finding),
      side: 'RIGHT',
      line: anchor.line,
      ...(anchor.startLine ? { start_line: anchor.startLine, start_side: 'RIGHT' } : {}),
    });
  }

  const dropped = before - posted.length - unanchored.length;
  const summaryBody = renderSummary(summary, posted, unanchored, cfg, dropped);

  // Gate on everything that survived filtering, whether or not GitHub let us
  // anchor it inline — an unanchored critical finding is still a critical finding.
  const highestSeverity = kept.reduce<Severity | null>(
    (acc, f) => (acc === null || SEVERITY_ORDER[f.severity] > SEVERITY_ORDER[acc] ? f.severity : acc),
    null,
  );

  if (cfg.dryRun) {
    core.info('[dry-run] Would post the following review:');
    core.info(summaryBody);
    for (const c of comments) core.info(JSON.stringify(c, null, 2));
    return { posted, unanchored, highestSeverity };
  }

  if (comments.length) {
    try {
      await octokit.rest.pulls.createReview({
        owner,
        repo,
        pull_number,
        commit_id,
        event: 'COMMENT',
        body: `${comments.length} new comment${comments.length === 1 ? '' : 's'} from Hawky. See the summary below.`,
        comments: comments as never,
      });
      core.info(`Posted ${comments.length} inline comment(s).`);
    } catch (err) {
      // One bad anchor rejects the whole review. Rather than lose the review,
      // fold everything into the summary comment.
      core.warning(
        `Could not post inline comments (${(err as Error).message}). Including them in the summary instead.`,
      );
      unanchored.push(...posted);
      posted.length = 0;
      await upsertSummary(octokit, owner, repo, pull_number, renderSummary(summary, [], unanchored, cfg, dropped));
      return { posted, unanchored, highestSeverity };
    }
  }

  await upsertSummary(octokit, owner, repo, pull_number, summaryBody);
  return { posted, unanchored, highestSeverity };
}
