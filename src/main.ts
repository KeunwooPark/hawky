import * as core from '@actions/core';
import * as github from '@actions/github';
import { loadConfig } from './config.js';
import { makeProvider } from './llm/index.js';
import { buildSystemPrompt, buildUserPrompt } from './prompts.js';
import { REVIEW_SCHEMA } from './schema.js';
import { SEVERITY_ORDER, type Finding, type ModelResult, type Refactor, type Severity, type Usage } from './types.js';
import { makeOctokit, resolveTarget } from './gh/client.js';
import { batchFiles, getCompareDiff, getPullRequestDiff } from './gh/diff.js';
import { postReview } from './gh/review.js';
import { postRefactorIssues } from './gh/issues.js';
import { isHawkyComment } from './util/fingerprint.js';

function mergeSummaries(summaries: string[], fallback: string): string {
  const clean = summaries.map((s) => s.trim()).filter(Boolean);
  if (clean.length <= 1) return clean[0] ?? fallback;
  return clean.map((s) => `- ${s}`).join('\n');
}

function logUsage(total: Usage, calls: number): void {
  core.info(
    `LLM: ${calls} call(s), ${total.inputTokens.toLocaleString()} input tokens ` +
      `(${total.cachedInputTokens.toLocaleString()} cached), ` +
      `${total.outputTokens.toLocaleString()} output tokens` +
      // Worth surfacing: it is the usual reason an output budget runs out.
      (total.reasoningTokens ? ` (${total.reasoningTokens.toLocaleString()} on reasoning)` : '') +
      '.',
  );
}

/**
 * True when this run was set off by a comment this action itself wrote.
 *
 * Wiring `issue_comment` or `pull_request_review_comment` as a trigger — which is
 * what you do so a dismissal takes effect without a push — otherwise loops: every
 * review comment and every summary update fires the workflow again, at the price
 * of a full re-review each time.
 */
function selfTriggered(): boolean {
  const comment = github.context.payload.comment as
    | { body?: string; user?: { type?: string } }
    | undefined;
  if (!comment) return false;
  return comment.user?.type === 'Bot' || isHawkyComment(comment.body);
}

/**
 * Written before anything that can throw so a job that gates on these outputs
 * reads a definite verdict even when the run dies early.
 */
function setVerdict(passed: boolean, highest: Severity | null): void {
  core.setOutput('review-passed', String(passed));
  core.setOutput('highest-severity', highest ?? 'none');
}

async function run(): Promise<void> {
  setVerdict(false, null);
  if (selfTriggered()) {
    core.info('Triggered by one of this action\'s own comments; nothing to do.');
    core.setOutput('findings-count', 0);
    core.setOutput('dismissed-count', 0);
    core.setOutput('issues-created', 0);
    core.setOutput('summary', 'Skipped: triggered by this action\'s own comment.');
    setVerdict(true, null);
    return;
  }
  const cfg = loadConfig();
  const octokit = makeOctokit(cfg.githubToken);
  const target = await resolveTarget(octokit);

  core.info(
    `Hawky: mode=${cfg.mode} provider=${cfg.provider} model=${cfg.model}` +
      (cfg.ponytail === 'off' ? '' : ` ponytail=${cfg.ponytail}`) +
      (target.pullNumber ? ` pr=#${target.pullNumber}` : ` commit=${target.headSha.slice(0, 7)}`),
  );

  const files = target.pullNumber
    ? await getPullRequestDiff(octokit, target.owner, target.repo, target.pullNumber, cfg)
    : target.baseSha
      ? await getCompareDiff(octokit, target.owner, target.repo, target.baseSha, target.headSha, cfg)
      : [];

  if (!files.length) {
    core.info('Nothing to review after filtering. Exiting.');
    core.setOutput('findings-count', 0);
    core.setOutput('dismissed-count', 0);
    core.setOutput('issues-created', 0);
    core.setOutput('summary', 'No reviewable changes.');
    setVerdict(true, null);
    return;
  }

  const provider = makeProvider(cfg);
  const system = buildSystemPrompt(cfg, cfg.mode);
  const batches = batchFiles(files, cfg.maxCharsPerBatch);
  core.info(`Reviewing ${files.length} file(s) in ${batches.length} batch(es).`);

  const findings: Finding[] = [];
  const refactors: Refactor[] = [];
  const summaries: string[] = [];
  const total: Usage = { inputTokens: 0, outputTokens: 0, cachedInputTokens: 0, reasoningTokens: 0 };
  let failedBatches = 0;

  for (const [index, batch] of batches.entries()) {
    core.startGroup(`Batch ${index + 1}/${batches.length} (${batch.map((f) => f.path).join(', ')})`);
    try {
      const { data, usage } = await provider.complete<ModelResult>({
        system,
        user: buildUserPrompt(target, batch, index, batches.length),
        schema: REVIEW_SCHEMA,
        schemaName: 'code_review',
        // The system prompt is identical for every batch, so cache it once.
        cacheSystem: batches.length > 1,
      });

      findings.push(...(data.findings ?? []));
      refactors.push(...(data.refactors ?? []));
      if (data.summary) summaries.push(data.summary);

      total.inputTokens += usage.inputTokens;
      total.outputTokens += usage.outputTokens;
      total.cachedInputTokens += usage.cachedInputTokens;
      total.reasoningTokens += usage.reasoningTokens;
      core.info(`${data.findings?.length ?? 0} finding(s), ${data.refactors?.length ?? 0} refactor(s).`);
    } catch (err) {
      // One failed batch should not throw away the batches that succeeded.
      failedBatches++;
      core.warning(`Batch ${index + 1} failed: ${(err as Error).message}`);
    } finally {
      core.endGroup();
    }
  }

  logUsage(total, batches.length);

  // Counted, not inferred from empty output: a clean diff legitimately produces
  // no findings and no refactors, and that is a pass, not a failure.
  if (failedBatches === batches.length) {
    throw new Error(
      `Every batch failed (${failedBatches} of ${batches.length}). See the warnings above for the underlying error.`,
    );
  }

  const summary = mergeSummaries(
    summaries,
    findings.length || refactors.length
      ? 'The model returned no summary; see the individual findings below.'
      : 'No defects found in the reviewed diff.',
  );
  let findingsPosted = 0;
  let dismissedCount = 0;
  let issuesCreated = 0;
  let highest: Severity | null = null;
  // A run that only reviewed part of the diff cannot honestly report a pass.
  const incomplete = failedBatches > 0 && cfg.failOnIncomplete;

  if (cfg.mode !== 'refactor' && target.pullNumber) {
    const result = await postReview(
      octokit,
      target.owner,
      target.repo,
      target.pullNumber,
      target.headSha,
      summary,
      findings,
      files,
      cfg,
      incomplete,
    );
    findingsPosted = result.posted.length + result.unanchored.length;
    dismissedCount = result.dismissed.length;
    highest = result.highestSeverity;
    for (const { finding, dismissal } of result.dismissed) {
      // In the log as well as on the pull request: a check that went green on a
      // waiver should be answerable from the run alone.
      core.info(
        `Waived by @${dismissal.by} (${dismissal.via}): ${finding.severity} ${finding.path}:${finding.line} ` +
          `— ${finding.title} — ${dismissal.reason}`,
      );
    }
  } else if (cfg.mode !== 'refactor') {
    core.warning('mode includes review but this event is not attached to a pull request; skipping inline comments.');
  }

  if (cfg.mode !== 'review') {
    issuesCreated = await postRefactorIssues(
      octokit,
      target.owner,
      target.repo,
      refactors,
      cfg,
      target.pullNumber ? { number: target.pullNumber, sha: target.headSha } : undefined,
    );
  }

  const gated =
    cfg.failOnSeverity !== 'none' && highest !== null && SEVERITY_ORDER[highest] >= SEVERITY_ORDER[cfg.failOnSeverity];

  // Always logged, including when the gate is off: "why did this pass?" has to be
  // answerable from the run log alone, without re-reading the workflow file.
  core.info(
    cfg.failOnSeverity === 'none'
      ? `Gate: off (fail-on-severity is not set). Highest severity found: ${highest ?? 'none'}. This run cannot fail on findings.`
      : `Gate: fail-on-severity=${cfg.failOnSeverity}, highest severity found=${highest ?? 'none'} -> ${gated ? 'FAIL' : 'pass'}` +
        (dismissedCount ? `, after ${dismissedCount} waived by a reviewer.` : '.'),
  );

  core.setOutput('findings-count', findingsPosted);
  core.setOutput('dismissed-count', dismissedCount);
  core.setOutput('issues-created', issuesCreated);
  core.setOutput('summary', summary);
  setVerdict(!gated && !incomplete, highest);

  await core.summary
    .addHeading('Hawky', 3)
    .addRaw(summary)
    .addList([
      `${findingsPosted} finding(s) reported`,
      `${dismissedCount} finding(s) waived by a reviewer`,
      `Highest severity: ${highest ?? 'none'}`,
      cfg.failOnSeverity === 'none'
        ? 'Gate: off (fail-on-severity is not set)'
        : `Gate: ${gated || incomplete ? 'FAIL' : 'pass'} (fail-on-severity: ${cfg.failOnSeverity})`,
      `${issuesCreated} refactoring issue(s) opened`,
      `${provider.name}/${provider.model}, ${total.inputTokens + total.outputTokens} tokens`,
    ])
    .write();

  if (gated) {
    core.setFailed(
      `Found a ${highest}-severity issue and fail-on-severity is set to ${cfg.failOnSeverity}.` +
        (cfg.dismissals === 'off'
          ? ''
          : ' If it is wrong, reply `@hawky ignore <reason>` in its thread and re-run this check.'),
    );
  } else if (incomplete) {
    core.setFailed(
      `${failedBatches} of ${batches.length} batch(es) failed, so the diff was only partly reviewed ` +
        'and the result cannot be trusted as a gate. Set fail-on-incomplete: false to allow partial reviews.',
    );
  }
}

run().catch((err: unknown) => {
  core.setFailed(err instanceof Error ? err.message : String(err));
});
