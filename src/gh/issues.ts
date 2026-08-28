import * as core from '@actions/core';
import type { Config } from '../config.js';
import type { Refactor } from '../types.js';
import { extractFingerprints, marker, refactorFingerprint } from '../util/fingerprint.js';
import type { Octokit } from './client.js';

const EFFORT_LABEL: Record<string, string> = {
  S: 'small (under a day)',
  M: 'medium (a few days)',
  L: 'large (a week or more)',
};

function renderIssue(refactor: Refactor, fingerprint: string, source?: { number: number; sha: string }): string {
  const lines = [
    refactor.rationale.trim(),
    '',
    '## Proposal',
    '',
    refactor.body.trim(),
    '',
    '## Scope',
    '',
    ...refactor.files.map((f) => `- \`${f}\``),
    '',
    `**Estimated effort:** ${EFFORT_LABEL[refactor.effort] ?? refactor.effort}`,
    '',
  ];

  if (source) {
    lines.push(`Surfaced while reviewing #${source.number} (\`${source.sha.slice(0, 7)}\`).`, '');
  }

  lines.push(
    '<sub>Opened automatically by Hawky. Close it if it is not worth doing — it will not be reopened.</sub>',
    '',
    marker('refactor', fingerprint),
  );
  return lines.join('\n');
}

/**
 * Fingerprints of refactors already tracked, in any state.
 *
 * Closed issues count: a maintainer closing "extract the retry logic" is a
 * decision, and reopening it on the next run would be obnoxious.
 */
async function trackedFingerprints(
  octokit: Octokit,
  owner: string,
  repo: string,
  labels: string[],
): Promise<Set<string>> {
  const issues = await octokit.paginate(octokit.rest.issues.listForRepo, {
    owner,
    repo,
    labels: labels.join(','),
    state: 'all',
    per_page: 100,
  });

  const seen = new Set<string>();
  for (const issue of issues) {
    if (issue.pull_request) continue;
    for (const fp of extractFingerprints(issue.body, 'refactor')) seen.add(fp);
  }
  core.debug(`Found ${seen.size} refactor(s) already tracked.`);
  return seen;
}

async function ensureLabels(octokit: Octokit, owner: string, repo: string, labels: string[]): Promise<void> {
  for (const name of labels) {
    try {
      await octokit.rest.issues.getLabel({ owner, repo, name });
    } catch {
      try {
        await octokit.rest.issues.createLabel({ owner, repo, name, color: '8250df' });
        core.info(`Created label "${name}".`);
      } catch (err) {
        // Losing a race with a concurrent run, or no permission to manage labels.
        core.debug(`Could not create label "${name}": ${(err as Error).message}`);
      }
    }
  }
}

export async function postRefactorIssues(
  octokit: Octokit,
  owner: string,
  repo: string,
  refactors: Refactor[],
  cfg: Config,
  source?: { number: number; sha: string },
): Promise<number> {
  if (!refactors.length) {
    core.info('No refactoring issues to open.');
    return 0;
  }

  const tracked = cfg.dryRun ? new Set<string>() : await trackedFingerprints(octokit, owner, repo, cfg.issueLabels);

  const seenThisRun = new Set<string>();
  const fresh = refactors.filter((r) => {
    const fp = refactorFingerprint(r.title, r.files);
    if (tracked.has(fp) || seenThisRun.has(fp)) return false;
    seenThisRun.add(fp);
    return true;
  });

  // Biggest wins first, so the cap keeps the ones worth having.
  const order: Record<string, number> = { L: 0, M: 1, S: 2 };
  const selected = fresh
    .sort((a, b) => (order[a.effort] ?? 3) - (order[b.effort] ?? 3))
    .slice(0, cfg.maxIssues);

  if (fresh.length > selected.length) {
    core.info(`Opening ${selected.length} of ${fresh.length} new refactors (max_issues).`);
  }

  if (cfg.dryRun) {
    for (const r of selected) {
      core.info(`[dry-run] Would open issue: ${r.title}`);
      core.info(renderIssue(r, refactorFingerprint(r.title, r.files), source));
    }
    return selected.length;
  }

  if (selected.length) {
    await ensureLabels(octokit, owner, repo, cfg.issueLabels);
  }

  let created = 0;
  for (const refactor of selected) {
    const fingerprint = refactorFingerprint(refactor.title, refactor.files);
    try {
      const { data } = await octokit.rest.issues.create({
        owner,
        repo,
        title: refactor.title,
        body: renderIssue(refactor, fingerprint, source),
        labels: cfg.issueLabels,
      });
      core.info(`Opened issue #${data.number}: ${refactor.title}`);
      created++;
    } catch (err) {
      core.warning(`Could not open issue "${refactor.title}": ${(err as Error).message}`);
    }
  }
  return created;
}
