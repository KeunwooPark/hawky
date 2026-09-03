import * as core from '@actions/core';
import type { Dismissals } from '../config.js';
import { extractFingerprints, isHawkyComment } from '../util/fingerprint.js';
import type { Octokit } from './client.js';

/**
 * Author associations trusted to waive a finding. Anyone can comment on a public
 * pull request, so the command is only honoured from people who could have
 * merged it anyway — otherwise the merge gate is bypassable by a stranger.
 */
const AUTHORIZED = new Set(['OWNER', 'MEMBER', 'COLLABORATOR']);

/** `@hawky ignore <optional finding id> <optional reason>`, on a line of its own. */
const COMMAND = /^[ \t>]*[@/]hawky[ \t]+(?:ignore|dismiss|false[- ]?positive)\b[ \t:,-]*(.*)$/im;

/** The 16-hex finding id, when the command names one instead of replying in a thread. */
const EXPLICIT_ID = /^([0-9a-f]{16})\b[ \t:,-]*(.*)$/;

const NO_REASON = 'no reason given';

export interface Dismissal {
  /** Who waived it. Recorded so a green check can still be audited. */
  by: string;
  reason: string;
  via: 'command' | 'resolved';
}

export interface ThreadState {
  /** Fingerprints already commented on, so an earlier finding is not reposted. */
  seen: Set<string>;
  /** Fingerprints a reviewer has waived. Excluded from the gate and from reposting. */
  dismissed: Map<string, Dismissal>;
}

interface CommentLike {
  body?: string | null;
  user?: { login?: string } | null;
  author_association?: string;
}

interface ReviewCommentLike extends CommentLike {
  id: number;
  in_reply_to_id?: number;
}

function parseCommand(body: string | null | undefined): { id?: string; reason: string } | null {
  if (!body) return null;
  const m = COMMAND.exec(body);
  if (!m) return null;
  const rest = (m[1] ?? '').trim();
  const explicit = EXPLICIT_ID.exec(rest);
  if (explicit) return { id: explicit[1], reason: explicit[2].trim() || NO_REASON };
  return { reason: rest || NO_REASON };
}

function authorized(comment: CommentLike): boolean {
  return AUTHORIZED.has((comment.author_association ?? '').toUpperCase());
}

function login(comment: CommentLike): string {
  return comment.user?.login ?? 'unknown';
}

/**
 * Threads GitHub reports as resolved, with the login that resolved them.
 *
 * REST does not expose `isResolved`, so this is the one GraphQL call in the
 * action. It is best-effort: an endpoint or token that refuses the query costs
 * the resolve gesture, not the run, and the `@hawky ignore` command still works.
 */
async function resolvedThreads(
  octokit: Octokit,
  owner: string,
  repo: string,
  pullNumber: number,
): Promise<Array<{ by: string; fingerprints: string[] }>> {
  const query = `
    query($owner: String!, $repo: String!, $number: Int!, $cursor: String) {
      repository(owner: $owner, name: $repo) {
        pullRequest(number: $number) {
          reviewThreads(first: 100, after: $cursor) {
            pageInfo { hasNextPage endCursor }
            nodes {
              isResolved
              resolvedBy { login }
              comments(first: 5) { nodes { body } }
            }
          }
        }
      }
    }`;

  type Page = {
    repository?: {
      pullRequest?: {
        reviewThreads: {
          pageInfo: { hasNextPage: boolean; endCursor: string | null };
          nodes: Array<{
            isResolved: boolean;
            resolvedBy: { login: string } | null;
            comments: { nodes: Array<{ body: string }> };
          }>;
        };
      };
    };
  };

  const out: Array<{ by: string; fingerprints: string[] }> = [];
  let cursor: string | null = null;
  // Bounded so a pathological pull request cannot spin here.
  for (let page = 0; page < 10; page++) {
    const data: Page = await octokit.graphql(query, { owner, repo, number: pullNumber, cursor });
    const threads = data.repository?.pullRequest?.reviewThreads;
    if (!threads) break;
    for (const thread of threads.nodes) {
      if (!thread.isResolved || !thread.resolvedBy) continue;
      const fingerprints = thread.comments.nodes.flatMap((c) => extractFingerprints(c.body, 'finding'));
      if (fingerprints.length) out.push({ by: thread.resolvedBy.login, fingerprints });
    }
    if (!threads.pageInfo.hasNextPage) break;
    cursor = threads.pageInfo.endCursor;
  }
  return out;
}

/**
 * Can this login merge? Resolving a thread is open to the pull request's author
 * as well as to maintainers, and on a fork that author is a stranger, so the
 * resolve gesture needs a permission check the `@hawky ignore` command gets for
 * free from `author_association`.
 *
 * Degrades closed: a token that cannot answer the question does not get to waive
 * the gate. It says so once, rather than quietly weakening the check.
 */
function writeAccessChecker(
  octokit: Octokit,
  owner: string,
  repo: string,
): (username: string) => Promise<boolean> {
  const cache = new Map<string, Promise<boolean>>();
  let warned = false;
  return (username: string) => {
    let hit = cache.get(username);
    if (!hit) {
      hit = octokit.rest.repos
        .getCollaboratorPermissionLevel({ owner, repo, username })
        .then(({ data }) => ['admin', 'write', 'maintain'].includes(data.permission))
        .catch((err: unknown) => {
          if (!warned) {
            warned = true;
            core.warning(
              `Could not check repository permissions (${(err as Error).message}), so resolving a thread ` +
                'will not waive a finding on this run. Reply `@hawky ignore <reason>` in the thread instead.',
            );
          }
          return false;
        });
      cache.set(username, hit);
    }
    return hit;
  };
}

/**
 * What the pull request's existing comments say about findings from earlier runs:
 * which ones have been reported, and which ones a reviewer has since waived.
 *
 * Without the second half a false positive is a deadlock — the gate re-reads every
 * finding on every push, so the only way to turn the check green is to change code
 * the reviewer has already decided is correct.
 */
export async function readThreadState(
  octokit: Octokit,
  owner: string,
  repo: string,
  pullNumber: number,
  issueComments: CommentLike[],
  mode: Dismissals,
): Promise<ThreadState> {
  const reviewComments = (await octokit.paginate(octokit.rest.pulls.listReviewComments, {
    owner,
    repo,
    pull_number: pullNumber,
    per_page: 100,
  })) as ReviewCommentLike[];

  const seen = new Set<string>();
  const byComment = new Map<number, string[]>();
  for (const c of reviewComments) {
    const fingerprints = extractFingerprints(c.body, 'finding');
    if (fingerprints.length) byComment.set(c.id, fingerprints);
    for (const fp of fingerprints) seen.add(fp);
  }
  core.debug(`Found ${seen.size} finding(s) already commented on this PR.`);

  const dismissed = new Map<string, Dismissal>();
  if (mode === 'off') return { seen, dismissed };

  const record = (fingerprints: string[], dismissal: Dismissal): void => {
    for (const fp of fingerprints) if (!dismissed.has(fp)) dismissed.set(fp, dismissal);
  };

  for (const c of reviewComments) {
    // Our own comments explain the command, so they contain it. Skip them outright
    // rather than relying on the explanation never looking like an invocation.
    if (isHawkyComment(c.body)) continue;
    const cmd = parseCommand(c.body);
    if (!cmd) continue;
    if (!authorized(c)) {
      core.warning(
        `Ignoring "@hawky ignore" from @${login(c)}: only a repository owner, member, or collaborator ` +
          'can waive a finding.',
      );
      continue;
    }
    const targets = cmd.id ? [cmd.id] : (c.in_reply_to_id ? byComment.get(c.in_reply_to_id) : undefined);
    if (!targets?.length) {
      core.warning(
        `Ignoring "@hawky ignore" from @${login(c)}: reply inside the thread of the finding you want ` +
          'waived, or name its id from the summary comment.',
      );
      continue;
    }
    record(targets, { by: login(c), reason: cmd.reason, via: 'command' });
  }

  // Pull-request-level comments have no thread to attach to, so they must name the
  // finding. That is the only route for a finding GitHub would not let us anchor.
  for (const c of issueComments) {
    if (isHawkyComment(c.body)) continue;
    const cmd = parseCommand(c.body);
    if (!cmd) continue;
    if (!authorized(c)) {
      core.warning(
        `Ignoring "@hawky ignore" from @${login(c)}: only a repository owner, member, or collaborator ` +
          'can waive a finding.',
      );
      continue;
    }
    if (!cmd.id) {
      core.warning(
        `Ignoring "@hawky ignore" from @${login(c)}: a pull request comment has to name the finding id ` +
          'listed in the summary, e.g. `@hawky ignore 0123456789abcdef not reachable here`.',
      );
      continue;
    }
    record([cmd.id], { by: login(c), reason: cmd.reason, via: 'command' });
  }

  if (mode === 'all') {
    try {
      const canWrite = writeAccessChecker(octokit, owner, repo);
      for (const thread of await resolvedThreads(octokit, owner, repo, pullNumber)) {
        if (!(await canWrite(thread.by))) continue;
        record(thread.fingerprints, { by: thread.by, reason: 'thread resolved', via: 'resolved' });
      }
    } catch (err) {
      core.warning(
        `Could not read resolved review threads (${(err as Error).message}); ` +
          'only `@hawky ignore` comments will waive a finding on this run.',
      );
    }
  }

  if (dismissed.size) core.info(`${dismissed.size} finding(s) waived by a reviewer.`);
  return { seen, dismissed };
}
