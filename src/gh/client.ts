import * as core from '@actions/core';
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

/**
 * Read the config file out of the repository itself.
 *
 * Reviewing a diff needs no checkout — that is the first promise the README makes
 * — but the config file was only ever read from one, so a workflow that followed
 * that advice had every setting in its file silently ignored. The file is part of
 * the repository, and the repository is already being read over the API, so it is
 * fetched the same way.
 *
 * At the head revision, which is what a checkout in the same job would have given
 * the run: a change to the review policy takes effect on the pull request that
 * makes it, rather than one merge later.
 *
 * Best-effort. A missing file is the ordinary case for a repository that
 * configures everything from the workflow, and an endpoint or token that refuses
 * the read costs the file, not the run.
 */
export async function fetchConfigFile(
  octokit: Octokit,
  owner: string,
  repo: string,
  path: string,
  ref: string,
): Promise<string | undefined> {
  try {
    const { data } = await octokit.rest.repos.getContent({ owner, repo, path, ref });
    if (Array.isArray(data) || data.type !== 'file') {
      core.warning(`${path} in this repository is not a file, so no configuration was read from it.`);
      return undefined;
    }
    // Over a megabyte, the API sends metadata and no content. A config file that
    // large is not a config file, so this is reported rather than worked around.
    if (data.encoding !== 'base64') {
      core.warning(`${path} was too large for the API to return; configure this run from action inputs instead.`);
      return undefined;
    }
    return Buffer.from(data.content, 'base64').toString('utf8');
  } catch (err) {
    const status = (err as { status?: number }).status;
    if (status === 404) {
      core.debug(`No ${path} in ${owner}/${repo} at ${ref}.`);
    } else {
      core.warning(
        `Could not read ${path} from the repository (${(err as Error).message}); ` +
          'this run uses action inputs and defaults only.',
      );
    }
    return undefined;
  }
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
