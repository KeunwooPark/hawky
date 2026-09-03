import assert from 'node:assert/strict';
import { test } from 'node:test';
import { readThreadState } from '../src/gh/dismissals.js';
import { findingFingerprint, marker, SUMMARY_MARKER } from '../src/util/fingerprint.js';

const LIST_REVIEW_COMMENTS = Symbol('pulls.listReviewComments');

const FP = findingFingerprint('src/a.ts', 'correctness', 'Off-by-one in the loop bound');
const OTHER = findingFingerprint('src/b.ts', 'correctness', 'Unchecked null');

interface Stub {
  body: string;
  id?: number;
  in_reply_to_id?: number;
  login?: string;
  association?: string;
}

function reviewComment(c: Stub) {
  return {
    id: c.id ?? 1,
    in_reply_to_id: c.in_reply_to_id,
    body: c.body,
    user: { login: c.login ?? 'alice' },
    author_association: c.association ?? 'COLLABORATOR',
  };
}

/** The finding comment hawky itself left, which replies attach to. */
const hawkyComment = reviewComment({ id: 10, body: `Off-by-one\n\n${marker('finding', FP)}` });

function stubOctokit(
  reviewComments: ReturnType<typeof reviewComment>[],
  threads?: { nodes: unknown[] },
  permissions: Record<string, string> = {},
) {
  return {
    paginate: async (route: unknown) => {
      if (route === LIST_REVIEW_COMMENTS) return reviewComments;
      throw new Error('unexpected paginate route');
    },
    graphql: async () => {
      if (!threads) throw new Error('graphql unavailable');
      return {
        repository: {
          pullRequest: { reviewThreads: { pageInfo: { hasNextPage: false, endCursor: null }, nodes: threads.nodes } },
        },
      };
    },
    rest: {
      pulls: { listReviewComments: LIST_REVIEW_COMMENTS },
      repos: {
        getCollaboratorPermissionLevel: async ({ username }: { username: string }) => {
          const permission = permissions[username];
          if (!permission) throw new Error('Not Found');
          return { data: { permission } };
        },
      },
    },
  } as never;
}

const read = (
  reviewComments: ReturnType<typeof reviewComment>[],
  issueComments: unknown[] = [],
  mode: 'all' | 'command' | 'off' = 'command',
  threads?: { nodes: unknown[] },
  permissions?: Record<string, string>,
) => readThreadState(stubOctokit(reviewComments, threads, permissions), 'o', 'r', 1, issueComments as never, mode);

test('a reply in the thread waives the finding it replies to', async () => {
  const { seen, dismissed } = await read([
    hawkyComment,
    reviewComment({ id: 11, in_reply_to_id: 10, body: '@hawky ignore x is validated in the caller' }),
  ]);

  assert.deepEqual([...seen], [FP]);
  assert.equal(dismissed.get(FP)?.by, 'alice');
  assert.equal(dismissed.get(FP)?.reason, 'x is validated in the caller');
  assert.equal(dismissed.get(FP)?.via, 'command');
});

test('a reply without a reason still waives, and records that none was given', async () => {
  const { dismissed } = await read([
    hawkyComment,
    reviewComment({ id: 11, in_reply_to_id: 10, body: 'Looks wrong to me.\n@hawky ignore' }),
  ]);
  assert.equal(dismissed.get(FP)?.reason, 'no reason given');
});

test('an outsider cannot waive a finding', async () => {
  // Anyone can comment on a public pull request; the gate would be worthless if
  // anyone could also talk their way past it.
  const { dismissed } = await read([
    hawkyComment,
    reviewComment({ id: 11, in_reply_to_id: 10, body: '@hawky ignore', login: 'drive-by', association: 'NONE' }),
  ]);
  assert.equal(dismissed.size, 0);
});

test('a reply in one thread does not waive a finding in another', async () => {
  const other = reviewComment({ id: 20, body: marker('finding', OTHER) });
  const { dismissed } = await read([
    hawkyComment,
    other,
    reviewComment({ id: 21, in_reply_to_id: 20, body: '@hawky ignore intentional' }),
  ]);
  assert.deepEqual([...dismissed.keys()], [OTHER]);
});

test('a pull request comment waives the finding whose id it names', async () => {
  // The only route for a finding GitHub would not let us anchor: no thread exists
  // to reply in, so the summary prints the id and the id is what gets named.
  const { dismissed } = await read(
    [hawkyComment],
    [{ body: `@hawky ignore ${FP} generated file`, user: { login: 'bob' }, author_association: 'MEMBER' }],
  );
  assert.equal(dismissed.get(FP)?.by, 'bob');
  assert.equal(dismissed.get(FP)?.reason, 'generated file');
});

test('a pull request comment that names no finding waives nothing', async () => {
  const { dismissed } = await read(
    [hawkyComment],
    [{ body: '@hawky ignore', user: { login: 'bob' }, author_association: 'MEMBER' }],
  );
  assert.equal(dismissed.size, 0);
});

test("hawky's own comment cannot waive its own finding", async () => {
  const { dismissed } = await read([
    reviewComment({ id: 10, body: `@hawky ignore this\n\n${marker('finding', FP)}` }),
  ]);
  assert.equal(dismissed.size, 0);
});

test('dismissals: off ignores every waiver', async () => {
  const { seen, dismissed } = await read(
    [hawkyComment, reviewComment({ id: 11, in_reply_to_id: 10, body: '@hawky ignore' })],
    [],
    'off',
  );
  assert.deepEqual([...seen], [FP]);
  assert.equal(dismissed.size, 0);
});

const resolvedThread = (by: string) => ({
  nodes: [{ isResolved: true, resolvedBy: { login: by }, comments: { nodes: [{ body: marker('finding', FP) }] } }],
});

test('a resolved thread waives the finding when the resolver can merge', async () => {
  const { dismissed } = await read([hawkyComment], [], 'all', resolvedThread('carol'), { carol: 'write' });
  assert.equal(dismissed.get(FP)?.via, 'resolved');
  assert.equal(dismissed.get(FP)?.by, 'carol');
});

test('a resolved thread waives nothing when the resolver cannot merge', async () => {
  // GitHub lets the pull request author resolve threads too, and on a fork that
  // author is a stranger.
  const { dismissed } = await read([hawkyComment], [], 'all', resolvedThread('drive-by'), { 'drive-by': 'read' });
  assert.equal(dismissed.size, 0);
});

test('an unresolved thread waives nothing', async () => {
  const nodes = { nodes: [{ isResolved: false, resolvedBy: null, comments: { nodes: [{ body: marker('finding', FP) }] } }] };
  const { dismissed } = await read([hawkyComment], [], 'all', nodes, { carol: 'write' });
  assert.equal(dismissed.size, 0);
});

test('dismissals: command ignores a resolved thread', async () => {
  const { dismissed } = await read([hawkyComment], [], 'command', resolvedThread('carol'), { carol: 'write' });
  assert.equal(dismissed.size, 0);
});

test('an unavailable GraphQL endpoint costs the resolve gesture, not the run', async () => {
  const { seen, dismissed } = await read(
    [hawkyComment, reviewComment({ id: 11, in_reply_to_id: 10, body: '@hawky ignore still fine' })],
    [],
    'all',
  );
  assert.deepEqual([...seen], [FP]);
  assert.equal(dismissed.get(FP)?.reason, 'still fine');
});

test("hawky's own summary comment cannot waive a finding by explaining the command", async () => {
  // The summary tells the reader to write `@hawky ignore <reason>`. Reading that
  // back as an invocation would waive findings nobody waived.
  const { dismissed } = await read(
    [hawkyComment],
    [
      {
        body: `${SUMMARY_MARKER}\n## Hawky review\n@hawky ignore ${FP} would be self-inflicted`,
        user: { login: 'github-actions[bot]' },
        author_association: 'MEMBER',
      },
    ],
  );
  assert.equal(dismissed.size, 0);
});
