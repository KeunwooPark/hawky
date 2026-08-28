import * as github from '@actions/github';

export type Octokit = ReturnType<typeof github.getOctokit>;

export function makeOctokit(token: string): Octokit {
  if (!token) {
    throw new Error(
      'No GitHub token available. Pass `github-token` or make sure `${{ github.token }}` is available to the job.',
    );
  }
  return github.getOctokit(token);
}

export interface Target {
  owner: string;
  repo: string;
  /** Undefined when running outside a pull request (e.g. a push to the default branch). */
  pullNumber?: number;
  headSha: string;
  baseSha?: string;
  title: string;
  description: string;
}

/**
 * Work out what to review from whatever event fired the workflow. Consumers wire
 * up their own triggers, so this has to cover pull_request, issue_comment on a PR,
 * workflow_dispatch, and push (where we look for the PR the commit came from).
 */
export async function resolveTarget(octokit: Octokit): Promise<Target> {
  const { owner, repo } = github.context.repo;
  const payload = github.context.payload;

  // Explicit override, for the workflow_run pattern that reviews fork pull
  // requests without checking out untrusted code (see examples/fork-safe.yml).
  const override = Number(process.env.HAWKY_PR_NUMBER);
  if (Number.isInteger(override) && override > 0) {
    const { data } = await octokit.rest.pulls.get({ owner, repo, pull_number: override });
    return {
      owner,
      repo,
      pullNumber: data.number,
      headSha: data.head.sha,
      baseSha: data.base.sha,
      title: data.title,
      description: data.body ?? '',
    };
  }

  const fromPr = payload.pull_request as
    | { number: number; title?: string; body?: string; head: { sha: string }; base: { sha: string } }
    | undefined;

  if (fromPr) {
    return {
      owner,
      repo,
      pullNumber: fromPr.number,
      headSha: fromPr.head.sha,
      baseSha: fromPr.base.sha,
      title: fromPr.title ?? '',
      description: fromPr.body ?? '',
    };
  }

  // issue_comment on a pull request
  if (payload.issue?.pull_request) {
    const { data } = await octokit.rest.pulls.get({
      owner,
      repo,
      pull_number: payload.issue.number,
    });
    return {
      owner,
      repo,
      pullNumber: data.number,
      headSha: data.head.sha,
      baseSha: data.base.sha,
      title: data.title,
      description: data.body ?? '',
    };
  }

  const sha = github.context.sha;

  // push / workflow_dispatch: prefer the PR the commit came from, so refactor
  // suggestions can cite the PR that introduced the code.
  const { data: associated } = await octokit.rest.repos.listPullRequestsAssociatedWithCommit({
    owner,
    repo,
    commit_sha: sha,
  });
  const merged = associated.find((pr) => pr.merged_at) ?? associated[0];
  if (merged) {
    return {
      owner,
      repo,
      pullNumber: merged.number,
      headSha: merged.head.sha,
      baseSha: merged.base.sha,
      title: merged.title,
      description: merged.body ?? '',
    };
  }

  return {
    owner,
    repo,
    headSha: sha,
    baseSha: (payload.before as string | undefined) ?? undefined,
    title: (payload.head_commit as { message?: string } | undefined)?.message ?? '',
    description: '',
  };
}
