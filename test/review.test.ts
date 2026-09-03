import assert from 'node:assert/strict';
import { test } from 'node:test';
import { postReview } from '../src/gh/review.js';
import type { Config } from '../src/config.js';
import { findingFingerprint, marker } from '../src/util/fingerprint.js';
import type { DiffFile, Finding, Severity } from '../src/types.js';

const LIST_REVIEW_COMMENTS = Symbol('pulls.listReviewComments');
const LIST_ISSUE_COMMENTS = Symbol('issues.listComments');

interface ReviewCommentStub {
  body: string;
  id?: number;
  in_reply_to_id?: number;
  author_association?: string;
  user?: { login: string };
}

/** Minimal Octokit stand-in: only the calls postReview actually makes. */
function stubOctokit(existingReviewComments: ReviewCommentStub[]) {
  return {
    paginate: async (route: unknown) => {
      if (route === LIST_REVIEW_COMMENTS) return existingReviewComments;
      if (route === LIST_ISSUE_COMMENTS) return [];
      throw new Error('unexpected paginate route');
    },
    rest: {
      pulls: { listReviewComments: LIST_REVIEW_COMMENTS, createReview: async () => ({}) },
      issues: {
        listComments: LIST_ISSUE_COMMENTS,
        createComment: async () => ({}),
        updateComment: async () => ({}),
      },
    },
  } as never;
}

const cfg = {
  provider: 'anthropic',
  model: 'claude-opus-5',
  minSeverity: 'medium',
  minConfidence: 0.6,
  maxComments: 15,
  dryRun: false,
  failOnSeverity: 'none',
  dismissals: 'command',
} as Config;

function file(path: string): DiffFile {
  return {
    path,
    status: 'modified',
    additions: 1,
    deletions: 0,
    patch: '',
    commentableLines: new Set([1, 2, 3]),
    annotated: '',
  };
}

function finding(severity: Severity, title: string, confidence = 0.9): Finding {
  return {
    path: 'src/a.ts',
    line: 1,
    severity,
    confidence,
    category: 'correctness',
    title,
    body: 'body',
  };
}

const post = (findings: Finding[], existing: ReviewCommentStub[] = []) =>
  postReview(stubOctokit(existing), 'o', 'r', 1, 'sha', 'summary', findings, [file('src/a.ts')], cfg);

test('gating severity reflects the highest finding that cleared the filters', async () => {
  const result = await post([finding('medium', 'a'), finding('critical', 'b')]);
  assert.equal(result.highestSeverity, 'critical');
});

test('gating severity survives a finding already commented on by an earlier run', async () => {
  const f = finding('critical', 'b');
  const existing = [{ body: marker('finding', findingFingerprint(f.path, f.category, f.title)) }];

  const result = await post([f], existing);

  // Nothing new to post, but the unresolved critical finding must still gate.
  assert.equal(result.posted.length, 0);
  assert.equal(result.highestSeverity, 'critical');
});

/** The finding comment hawky left, plus a maintainer's reply waiving it. */
function waived(f: Finding, reason = 'x is validated in the caller'): ReviewCommentStub[] {
  return [
    { id: 10, body: marker('finding', findingFingerprint(f.path, f.category, f.title)) },
    {
      id: 11,
      in_reply_to_id: 10,
      body: `@hawky ignore ${reason}`,
      author_association: 'COLLABORATOR',
      user: { login: 'alice' },
    },
  ];
}

test('a finding a reviewer waived stops gating', async () => {
  // The deadlock this exists to break: without a waiver the gate re-reads the
  // same false positive on every push, and only a code change clears it.
  const f = finding('critical', 'b');

  const result = await post([f], waived(f));

  assert.equal(result.highestSeverity, null);
  assert.equal(result.dismissed.length, 1);
  assert.equal(result.dismissed[0].dismissal.by, 'alice');
});

test('a waived finding is not reposted either', async () => {
  const f = finding('critical', 'b');
  const result = await post([f], waived(f));
  assert.equal(result.posted.length, 0);
  assert.equal(result.unanchored.length, 0);
});

test('waiving one finding leaves the rest gating', async () => {
  const f = finding('high', 'b');
  const result = await post([f, finding('critical', 'c')], waived(f));
  assert.equal(result.highestSeverity, 'critical');
});

test('findings below the severity or confidence floor do not gate', async () => {
  const result = await post([finding('low', 'a'), finding('critical', 'b', 0.1)]);
  assert.equal(result.highestSeverity, null);
});

test('a finding outside the reviewed diff does not gate', async () => {
  const stray = { ...finding('critical', 'b'), path: 'src/elsewhere.ts' };
  const result = await post([stray]);
  assert.equal(result.highestSeverity, null);
});

/** Same stand-in, but keeps whatever body the sticky summary comment was given. */
function capturingOctokit(existingReviewComments: ReviewCommentStub[] = []) {
  const bodies: string[] = [];
  const octokit = {
    paginate: async (route: unknown) => {
      if (route === LIST_REVIEW_COMMENTS) return existingReviewComments;
      if (route === LIST_ISSUE_COMMENTS) return [];
      throw new Error('unexpected paginate route');
    },
    rest: {
      pulls: { listReviewComments: LIST_REVIEW_COMMENTS, createReview: async () => ({}) },
      issues: {
        listComments: LIST_ISSUE_COMMENTS,
        createComment: async ({ body }: { body: string }) => {
          bodies.push(body);
          return {};
        },
        updateComment: async () => ({}),
      },
    },
  } as never;
  return { octokit, bodies };
}

const postWith = async (overrides: Partial<Config>, findings: Finding[], incomplete = false) => {
  const { octokit, bodies } = capturingOctokit();
  await postReview(
    octokit,
    'o',
    'r',
    1,
    'sha',
    'summary',
    findings,
    [file('src/a.ts')],
    { ...cfg, ...overrides } as Config,
    incomplete,
  );
  return bodies[0] ?? '';
};

test('the summary comment says the gate is off when fail-on-severity is unset', async () => {
  const body = await postWith({ failOnSeverity: 'none' }, [finding('high', 'a')]);

  // The symptom this fixes: a High comment on a green check, with nothing on the
  // pull request explaining that no threshold was ever configured.
  assert.match(body, /Highest severity found: \*\*High\*\*/);
  assert.match(body, /Not gating/);
  assert.match(body, /fail-on-severity` is not set/);
});

test('the summary comment reports a failure when a finding crosses the threshold', async () => {
  const body = await postWith({ failOnSeverity: 'high' }, [finding('high', 'a')]);
  assert.match(body, /\*\*Failed\.\*\*/);
  assert.match(body, /At or above the `high` threshold/);
});

test('the summary comment reports a pass when everything is below the threshold', async () => {
  const body = await postWith({ failOnSeverity: 'high' }, [finding('medium', 'a')]);
  assert.match(body, /\*\*Passed\.\*\*/);
  assert.match(body, /Below the `high` threshold/);
});

test('a partly reviewed diff is reported as a failure, not a pass', async () => {
  const body = await postWith({ failOnSeverity: 'high' }, [finding('medium', 'a')], true);
  assert.match(body, /\*\*Failed\.\*\*/);
  assert.match(body, /could not be reviewed/);
});

test('the summary names who waived a finding and why', async () => {
  const f = finding('critical', 'b');
  const { octokit, bodies } = capturingOctokit(waived(f, 'the caller already checks this'));
  await postReview(octokit, 'o', 'r', 1, 'sha', 'summary', [f], [file('src/a.ts')], {
    ...cfg,
    failOnSeverity: 'high',
  } as Config);

  const body = bodies[0] ?? '';
  assert.match(body, /\*\*Passed\.\*\*/);
  // A check that is green only because of a waiver has to say so where the
  // person clicking merge will see it.
  assert.match(body, /1 finding waived by a reviewer/);
  assert.match(body, /@alice waived it: the caller already checks this/);
});

test('the summary prints an id for findings that could not be anchored', async () => {
  // There is no thread to reply in for these, so the id is the only way to waive one.
  const stray = { ...finding('high', 'a'), line: 99 };
  const body = await postWith({}, [stray]);
  assert.match(body, new RegExp(findingFingerprint(stray.path, stray.category, stray.title)));
});
