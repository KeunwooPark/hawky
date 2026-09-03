import assert from 'node:assert/strict';
import { test } from 'node:test';
import { postReview } from '../src/gh/review.js';
import type { Config } from '../src/config.js';
import { findingFingerprint, marker } from '../src/util/fingerprint.js';
import type { DiffFile, Finding, Severity } from '../src/types.js';

const LIST_REVIEW_COMMENTS = Symbol('pulls.listReviewComments');
const LIST_ISSUE_COMMENTS = Symbol('issues.listComments');

/** Minimal Octokit stand-in: only the calls postReview actually makes. */
function stubOctokit(existingReviewComments: Array<{ body: string }>) {
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

const post = (findings: Finding[], existing: Array<{ body: string }> = []) =>
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
function capturingOctokit() {
  const bodies: string[] = [];
  const octokit = {
    paginate: async (route: unknown) => {
      if (route === LIST_REVIEW_COMMENTS) return [];
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
