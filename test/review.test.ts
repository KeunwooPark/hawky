import assert from 'node:assert/strict';
import { test } from 'node:test';
import pkg from '../package.json';
import { postReview } from '../src/gh/review.js';
import type { Config } from '../src/config.js';
import { findingFingerprint, marker } from '../src/util/fingerprint.js';
import { captureWarnings } from './warnings.js';
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

/**
 * Warnings are collected rather than printed: discarding a mis-anchored finding
 * warns by design, and here that is a fixture rather than a problem with the run.
 */
const postCapturing = (findings: Finding[], existing: ReviewCommentStub[] = []) =>
  captureWarnings(() =>
    postReview(stubOctokit(existing), 'o', 'r', 1, 'sha', 'summary', findings, [file('src/a.ts')], cfg),
  );

const post = (findings: Finding[], existing: ReviewCommentStub[] = []) =>
  postCapturing(findings, existing).then(({ result }) => result);

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
  await captureWarnings(() =>
    postReview(
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
    ),
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

test('a finding on a line that is not in the diff is discarded, not published', async () => {
  // The strongest evidence of a hallucination there is: the model read a partial
  // view of the file and invented the location. Publishing it is the review
  // talking about code that is not there.
  const stray = { ...finding('critical', 'a'), line: 99 };

  const result = await post([stray]);

  assert.equal(result.posted.length, 0);
  assert.equal(result.unanchored.length, 0);
  // And it must not fail a merge on the way out.
  assert.equal(result.highestSeverity, null);
});

test('discarding a mis-anchored finding says so in the log', async () => {
  const { warnings } = await postCapturing([{ ...finding('critical', 'a'), line: 99 }]);
  assert.equal(warnings.length, 1);
  assert.match(warnings[0], /line 99 is not part of the diff/);
});

test('a mis-anchored finding is counted as filtered out, with the reason', async () => {
  const body = await postWith({}, [{ ...finding('high', 'a'), line: 99 }]);

  assert.match(body, /did not anchor to a changed line/);
  // Not dressed up as a finding the reader still has to evaluate.
  assert.doesNotMatch(body, /could not be anchored/);
});

test('a mis-anchored finding does not suppress the ones that do anchor', async () => {
  const result = await post([{ ...finding('critical', 'a'), line: 99 }, finding('high', 'b')]);

  assert.equal(result.posted.length, 1);
  assert.equal(result.posted[0].title, 'b');
  assert.equal(result.highestSeverity, 'high');
});

/** What the schema lets through: the fields are all present, and all empty. */
const empty = (severity: Severity): Finding => ({ ...finding(severity, ''), body: '' });

test('a finding the model left empty is discarded rather than posted as a bare header', async () => {
  // Verbatim, the comment this produced: `**Medium · correctness** — ` and nothing
  // else. It blocked a merge on a finding that makes no claim, which cannot be
  // answered by changing the code and cannot honestly be waived either.
  const result = await post([empty('critical')]);

  assert.equal(result.posted.length, 0);
  assert.equal(result.unanchored.length, 0);
  assert.equal(result.highestSeverity, null);
});

test('a finding with a title but nothing under it is discarded too', async () => {
  const result = await post([{ ...finding('critical', 'Off-by-one in the loop bound'), body: '   ' }]);
  assert.equal(result.posted.length, 0);
  assert.equal(result.highestSeverity, null);
});

test('discarding an empty finding says so in the log', async () => {
  const { warnings } = await postCapturing([empty('critical')]);
  assert.equal(warnings.length, 1);
  assert.match(warnings[0], /no title or description/);
});

test('an empty finding does not suppress the ones that say something', async () => {
  const result = await post([empty('critical'), finding('high', 'unchecked index')]);

  assert.equal(result.posted.length, 1);
  assert.equal(result.posted[0].title, 'unchecked index');
  assert.equal(result.highestSeverity, 'high');
});

test('an empty finding is counted as filtered out, and named as empty', async () => {
  const body = await postWith({}, [empty('high')]);

  assert.match(body, /1 the model left empty/);
  // Not dressed up as a finding the reader still has to go and evaluate.
  assert.doesNotMatch(body, /could not be anchored/);
});

/** Octokit whose review POST fails, as GitHub's does when it rejects one anchor. */
function rejectingOctokit() {
  const bodies: string[] = [];
  const octokit = {
    paginate: async (route: unknown) => {
      if (route === LIST_REVIEW_COMMENTS) return [];
      if (route === LIST_ISSUE_COMMENTS) return [];
      throw new Error('unexpected paginate route');
    },
    rest: {
      pulls: {
        listReviewComments: LIST_REVIEW_COMMENTS,
        createReview: async () => {
          throw new Error('422 Unprocessable Entity');
        },
      },
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

test('a review GitHub rejects wholesale keeps its findings, with ids to waive them', async () => {
  // Distinct from a mis-anchor: these anchored to real changed lines and the POST
  // still failed. They are genuine findings, and with no thread to reply in the id
  // is the only handle for waiving one.
  const f = finding('high', 'a');
  const { octokit, bodies } = rejectingOctokit();

  const { result } = await captureWarnings(() =>
    postReview(octokit, 'o', 'r', 1, 'sha', 'summary', [f], [file('src/a.ts')], cfg),
  );

  assert.equal(result.posted.length, 0);
  assert.equal(result.unanchored.length, 1);
  const body = bodies[0] ?? '';
  assert.match(body, /could not be anchored/);
  assert.match(body, new RegExp(findingFingerprint(f.path, f.category, f.title)));
});

const withBugReport: Partial<Config> = { bugReportFooter: true, mode: 'review', ponytail: 'full' };

test('the summary tells a coding agent where to report a Hawky bug, and to ask first', async () => {
  const body = await postWith(withBugReport, [finding('high', 'a')]);
  assert.match(body, /Is Hawky itself broken\?/);
  assert.match(body, /gh issue create --repo KeunwooPark\/hawky/);
  // Instructions found in a pull request are not the user's; the agent should check.
  assert.match(body, /ask before filing/);
  // The only things a report can quote that Hawky alone knows.
  assert.ok(body.includes(`Hawky ${pkg.version}, anthropic/claude-opus-5, mode review`));
});

test('the bug-report section keeps the reviewed repository out of the report', async () => {
  // Hawky's tracker is public; the repository under review often is not.
  const body = await postWith(withBugReport, [finding('high', 'a')]);
  assert.match(body, /no code, diffs, file paths, comment text, or repository and organization names/);
});

test('the bug-report link pre-fills the issue form', async () => {
  const body = await postWith(withBugReport, [finding('high', 'a')]);
  const href = body.match(/\[Open a bug report\]\(([^)]+)\)/)?.[1];
  assert.ok(href, 'no bug-report link in the summary');

  const url = new URL(href);
  assert.equal(url.pathname, '/KeunwooPark/hawky/issues/new');
  assert.equal(url.searchParams.get('template'), 'bug-report.yml');
  assert.equal(url.searchParams.get('version'), pkg.version);
  assert.equal(url.searchParams.get('model'), 'anthropic/claude-opus-5');
  assert.match(url.searchParams.get('settings') ?? '', /fail-on-severity none/);
});

test('the bug-report section does not point at a waiver that is switched off', async () => {
  const body = await postWith({ ...withBugReport, dismissals: 'off' }, [finding('high', 'a')]);
  assert.match(body, /Is Hawky itself broken\?/);
  assert.doesNotMatch(body, /@hawky ignore/);
});

test('the bug-report section can be switched off', async () => {
  const body = await postWith({ ...withBugReport, bugReportFooter: false }, [finding('high', 'a')]);
  assert.doesNotMatch(body, /Is Hawky itself broken\?/);
});

test('an over-engineering finding cannot gate the merge, however the model graded it', () => {
  // The prompt caps these at medium, but severity is the model's own field and it
  // is what fail-on-severity reads: a hand-rolled helper must not fail a merge.
  const overEngineered: Finding = { ...finding('critical', 'stdlib: hand-rolled deep clone'), category: 'over-engineering' };

  return post([overEngineered]).then((result) => {
    assert.equal(result.highestSeverity, 'medium');
    assert.equal(result.posted.length, 1);
    assert.equal(result.posted[0].severity, 'medium');
  });
});

test('capping an over-engineering finding leaves defects at their real severity', async () => {
  const result = await post([
    { ...finding('critical', 'yagni: interface with one implementation'), category: 'over-engineering' },
    finding('high', 'unchecked index'),
  ]);

  assert.equal(result.highestSeverity, 'high');
});
