import * as core from '@actions/core';
import { loadConfig } from './config.js';
import { makeProvider } from './llm/index.js';
import { buildSystemPrompt, buildUserPrompt } from './prompts.js';
import { REVIEW_SCHEMA } from './schema.js';
import { SEVERITY_ORDER, type Finding, type ModelResult, type Refactor, type Severity, type Usage } from './types.js';
import { makeOctokit, resolveTarget } from './gh/client.js';
import { batchFiles, getCompareDiff, getPullRequestDiff } from './gh/diff.js';
import { postReview } from './gh/review.js';
import { postRefactorIssues } from './gh/issues.js';

const MAX_RESPONSE_TOKENS = 16_000;

function mergeSummaries(summaries: string[]): string {
  const clean = summaries.map((s) => s.trim()).filter(Boolean);
  if (clean.length <= 1) return clean[0] ?? 'No reviewable changes found.';
  return clean.map((s) => `- ${s}`).join('\n');
}

function logUsage(total: Usage, calls: number): void {
  core.info(
    `LLM: ${calls} call(s), ${total.inputTokens.toLocaleString()} input tokens ` +
      `(${total.cachedInputTokens.toLocaleString()} cached), ` +
      `${total.outputTokens.toLocaleString()} output tokens.`,
  );
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
  const cfg = loadConfig();
  const octokit = makeOctokit(cfg.githubToken);
  const target = await resolveTarget(octokit);

  core.info(
    `Hawky: mode=${cfg.mode} provider=${cfg.provider} model=${cfg.model}` +
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
  const total: Usage = { inputTokens: 0, outputTokens: 0, cachedInputTokens: 0 };
  let failedBatches = 0;

  for (const [index, batch] of batches.entries()) {
    core.startGroup(`Batch ${index + 1}/${batches.length} (${batch.map((f) => f.path).join(', ')})`);
    try {
      const { data, usage } = await provider.complete<ModelResult>({
        system,
        user: buildUserPrompt(target, batch, index, batches.length),
        schema: REVIEW_SCHEMA,
        schemaName: 'code_review',
        maxTokens: MAX_RESPONSE_TOKENS,
        // The system prompt is identical for every batch, so cache it once.
        cacheSystem: batches.length > 1,
      });

      findings.push(...(data.findings ?? []));
      refactors.push(...(data.refactors ?? []));
      if (data.summary) summaries.push(data.summary);

      total.inputTokens += usage.inputTokens;
      total.outputTokens += usage.outputTokens;
      total.cachedInputTokens += usage.cachedInputTokens;
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

  if (!summaries.length && !findings.length && !refactors.length) {
    throw new Error('Every batch failed. See the warnings above for the underlying error.');
  }

  const summary = mergeSummaries(summaries);
  let findingsPosted = 0;
  let issuesCreated = 0;
  let highest: Severity | null = null;

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
    );
    findingsPosted = result.posted.length + result.unanchored.length;
    highest = result.highestSeverity;
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

  // A run that only reviewed part of the diff cannot honestly report a pass.
  const incomplete = failedBatches > 0 && cfg.failOnIncomplete;
  const gated =
    cfg.failOnSeverity !== 'none' && highest !== null && SEVERITY_ORDER[highest] >= SEVERITY_ORDER[cfg.failOnSeverity];

  core.setOutput('findings-count', findingsPosted);
  core.setOutput('issues-created', issuesCreated);
  core.setOutput('summary', summary);
  setVerdict(!gated && !incomplete, highest);

  await core.summary
    .addHeading('Hawky', 3)
    .addRaw(summary)
    .addList([
      `${findingsPosted} finding(s) reported`,
      `Highest severity: ${highest ?? 'none'}`,
      `${issuesCreated} refactoring issue(s) opened`,
      `${provider.name}/${provider.model}, ${total.inputTokens + total.outputTokens} tokens`,
    ])
    .write();

  if (gated) {
    core.setFailed(`Found a ${highest}-severity issue and fail-on-severity is set to ${cfg.failOnSeverity}.`);
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
