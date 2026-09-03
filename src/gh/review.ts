import * as core from '@actions/core';
import type { Config } from '../config.js';
import { SEVERITY_ORDER, type DiffFile, type Finding, type Severity } from '../types.js';
import { findingFingerprint, marker, SUMMARY_MARKER } from '../util/fingerprint.js';
import type { Octokit } from './client.js';
import { type Dismissal, readThreadState } from './dismissals.js';

const SEVERITY_LABEL: Record<Severity, string> = {
  critical: 'Critical',
  high: 'High',
  medium: 'Medium',
  low: 'Low',
};

/** A multi-line anchor spanning more than this is almost always a mis-anchor. */
const MAX_ANCHOR_SPAN = 20;

/** A finding a reviewer has waived, kept together with who waived it and why. */
export interface DismissedFinding {
  finding: Finding;
  dismissal: Dismissal;
}

export interface PostedReview {
  posted: Finding[];
  /** Findings whose anchor GitHub would reject; folded into the summary instead. */
  unanchored: Finding[];
  /** Findings a reviewer waived. Reported, but deliberately not gated on. */
  dismissed: DismissedFinding[];
  /**
   * Highest severity among findings that cleared the quality bar on this run,
   * including ones suppressed as duplicates but excluding ones a reviewer has
   * waived. This is what gating reads, so it must not depend on whether a
   * comment happened to be new.
   */
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

/**
 * The one line that says whether this check passed, written where the reviewer
 * already is. Without it the verdict lived only in step outputs and the job
 * summary, so a gate that was never switched on looked identical to one that
 * was switched on and found nothing.
 */
function renderVerdict(
  highest: Severity | null,
  cfg: Config,
  incomplete: boolean,
  dismissed: DismissedFinding[],
): string {
  const found = highest ? `Highest severity found: **${SEVERITY_LABEL[highest]}**.` : 'Nothing found.';
  // A check that is only green because someone waived a finding has to say so on
  // the pull request, or the waiver is invisible to whoever approves it.
  const waived = dismissed.length
    ? ` ${dismissed.length} finding${dismissed.length === 1 ? '' : 's'} waived by a reviewer, listed below.`
    : '';

  if (cfg.failOnSeverity === 'none') {
    return `${found} Not gating — \`fail-on-severity\` is not set, so this check passes whatever is found.${waived}`;
  }
  if (highest && severityAtLeast(highest, cfg.failOnSeverity)) {
    return `❌ **Failed.** ${found} At or above the \`${cfg.failOnSeverity}\` threshold.${waived}`;
  }
  if (incomplete) {
    return `❌ **Failed.** ${found} Part of the diff could not be reviewed, so the result cannot be trusted as a gate.${waived}`;
  }
  return `✅ **Passed.** ${found} Below the \`${cfg.failOnSeverity}\` threshold.${waived}`;
}

function renderSummary(
  summary: string,
  posted: Finding[],
  unanchored: Finding[],
  dismissed: DismissedFinding[],
  cfg: Config,
  dropped: number,
  highest: Severity | null,
  incomplete: boolean,
): string {
  const lines = [
    SUMMARY_MARKER,
    '## Hawky review',
    '',
    summary.trim(),
    '',
    renderVerdict(highest, cfg, incomplete, dismissed),
    '',
  ];

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
      // The id is the only handle on these: there is no thread to reply in, so a
      // false positive here can only be waived by naming it.
      const id = findingFingerprint(f.path, f.category, f.title);
      lines.push(
        `- **${f.path}:${f.line}** — ${SEVERITY_LABEL[f.severity]} · ${f.title} \`${id}\``,
        '',
        `  ${f.body.trim().replace(/\n/g, '\n  ')}`,
        '',
      );
    }
    lines.push('</details>', '');
  }

  if (dismissed.length) {
    lines.push(
      `<details><summary>${dismissed.length} finding${dismissed.length === 1 ? '' : 's'} waived by a reviewer</summary>`,
      '',
    );
    for (const { finding: f, dismissal: d } of dismissed) {
      const how = d.via === 'resolved' ? 'resolved the thread' : 'waived it';
      lines.push(
        `- **${f.path}:${f.line}** — ${SEVERITY_LABEL[f.severity]} · ${f.title}` +
          ` — @${d.by} ${how}: ${d.reason}`,
      );
    }
    lines.push(
      '',
      'These do not gate the merge. Reverse one by deleting the comment that waived it ' +
        '(or unresolving its thread) and re-running this check.',
      '',
      '</details>',
      '',
    );
  }

  if (dropped) {
    lines.push(
      `_${dropped} lower-signal finding${dropped === 1 ? '' : 's'} filtered out ` +
        `(below \`${cfg.minSeverity}\` severity or \`${cfg.minConfidence}\` confidence, or already commented on)._`,
      '',
    );
  }

  if (cfg.dismissals !== 'off') {
    lines.push(
      '<sub>Wrong about something? Reply `@hawky ignore <reason>` in its thread' +
        (cfg.dismissals === 'all' ? ', or resolve the thread,' : '') +
        ' and re-run this check.</sub>',
      '',
    );
  }

  lines.push(`<sub>Reviewed by ${cfg.provider}/${cfg.model}. Re-run by pushing a commit.</sub>`);
  return lines.join('\n');
}

type IssueComment = { id: number; body?: string | null };

async function listIssueComments(
  octokit: Octokit,
  owner: string,
  repo: string,
  issue_number: number,
): Promise<IssueComment[]> {
  return (await octokit.paginate(octokit.rest.issues.listComments, {
    owner,
    repo,
    issue_number,
    per_page: 100,
  })) as IssueComment[];
}

async function upsertSummary(
  octokit: Octokit,
  owner: string,
  repo: string,
  issue_number: number,
  comments: IssueComment[],
  body: string,
): Promise<void> {
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
  /** Some of the diff could not be reviewed and the run is configured to fail on that. */
  incomplete = false,
): Promise<PostedReview> {
  const byPath = new Map(files.map((f) => [f.path, f]));
  const issueComments = cfg.dryRun ? [] : await listIssueComments(octokit, owner, repo, pull_number);
  const { seen: alreadyPosted, dismissed: waived } = cfg.dryRun
    ? { seen: new Set<string>(), dismissed: new Map<string, Dismissal>() }
    : await readThreadState(octokit, owner, repo, pull_number, issueComments, cfg.dismissals);

  const before = findings.length;
  const qualified = findings
    .filter((f) => byPath.has(f.path))
    .filter((f) => severityAtLeast(f.severity, cfg.minSeverity))
    .filter((f) => (f.confidence ?? 0) >= cfg.minConfidence)
    .sort(
      (a, b) =>
        SEVERITY_ORDER[b.severity] - SEVERITY_ORDER[a.severity] || (b.confidence ?? 0) - (a.confidence ?? 0),
    );

  // A waived finding leaves the run entirely: it does not gate, and it is not
  // reposted either, so re-reviewing does not resurrect the argument.
  const dismissed: DismissedFinding[] = [];
  const active: Finding[] = [];
  for (const f of qualified) {
    const d = waived.get(findingFingerprint(f.path, f.category, f.title));
    if (d) dismissed.push({ finding: f, dismissal: d });
    else active.push(f);
  }

  const kept = active
    .filter((f) => !alreadyPosted.has(findingFingerprint(f.path, f.category, f.title)))
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

  // Waived findings are reported in their own section, so they must not also be
  // counted among the ones quietly filtered out.
  const dropped = before - posted.length - unanchored.length - dismissed.length;

  // Gate on everything that survived the quality filters, whether or not GitHub
  // let us anchor it inline and whether or not an earlier run already commented
  // on it: an unresolved critical finding is still critical on the second push.
  const highestSeverity = active.reduce<Severity | null>(
    (acc, f) => (acc === null || SEVERITY_ORDER[f.severity] > SEVERITY_ORDER[acc] ? f.severity : acc),
    null,
  );

  const summaryBody = renderSummary(summary, posted, unanchored, dismissed, cfg, dropped, highestSeverity, incomplete);

  if (cfg.dryRun) {
    core.info('[dry-run] Would post the following review:');
    core.info(summaryBody);
    for (const c of comments) core.info(JSON.stringify(c, null, 2));
    return { posted, unanchored, dismissed, highestSeverity };
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
      await upsertSummary(
        octokit,
        owner,
        repo,
        pull_number,
        issueComments,
        renderSummary(summary, [], unanchored, dismissed, cfg, dropped, highestSeverity, incomplete),
      );
      return { posted, unanchored, dismissed, highestSeverity };
    }
  }

  await upsertSummary(octokit, owner, repo, pull_number, issueComments, summaryBody);
  return { posted, unanchored, dismissed, highestSeverity };
}
