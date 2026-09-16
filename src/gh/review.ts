import * as core from '@actions/core';
import pkg from '../../package.json';
import type { Config } from '../config.js';
import { SEVERITY_ORDER, type DiffFile, type Finding, type Severity } from '../types.js';
import { screenFinding, screenSuggestion } from '../util/finding.js';
import { parsePatch } from './diff.js';
import { findingFingerprint, marker, sameClaim, SUMMARY_MARKER } from '../util/fingerprint.js';
import type { ReviewSummary } from '../util/summary.js';
import type { Octokit } from './client.js';
import { type Dismissal, type ThreadState, readThreadState } from './dismissals.js';

const SEVERITY_LABEL: Record<Severity, string> = {
  critical: 'Critical',
  high: 'High',
  medium: 'Medium',
  low: 'Low',
};

/** A multi-line anchor spanning more than this is almost always a mis-anchor. */
const MAX_ANCHOR_SPAN = 20;

/**
 * Past this many files, one pass over the diff is a sample of its defects rather
 * than a list of them.
 *
 * Measured rather than assumed: on one large pull request the review converged
 * over twelve runs, each posting between one and five findings that were mostly
 * new rather than repeats — several of them on code earlier runs had read and said
 * nothing about. Nothing was being truncated and the batches did not change. That
 * is what sampling a model once per batch does, and the cost of not saying so is
 * that a first-run pass and a twelfth-run pass read identically.
 */
const SAMPLED_FROM_FILES = 10;

/** Where Hawky's own bugs are filed. Public, unlike many repositories it reviews. */
const HAWKY_REPO = 'KeunwooPark/hawky';

/** A finding a reviewer has waived, kept together with who waived it and why. */
export interface DismissedFinding {
  finding: Finding;
  dismissal: Dismissal;
  /**
   * The waived title this one was matched to, when the match was on wording rather
   * than on an identical fingerprint. Reported, so a match is visible as a match.
   */
  rewordingOf?: string;
}

export interface PostedReview {
  posted: Finding[];
  /** Findings whose anchor GitHub would reject; folded into the summary instead. */
  unanchored: Finding[];
  /** Findings a reviewer waived. Reported, but deliberately not gated on. */
  dismissed: DismissedFinding[];
  /**
   * Highest severity among findings that cleared the quality bar on this run,
   * including ones suppressed as duplicates but excluding ones a reviewer has
   * waived. This is what gating reads, so it must not depend on whether a
   * comment happened to be new.
   */
  highestSeverity: Severity | null;
}

function severityAtLeast(value: Severity, floor: Severity): boolean {
  return SEVERITY_ORDER[value] >= SEVERITY_ORDER[floor];
}

/**
 * The highest severity an over-engineering finding is allowed to carry.
 *
 * The prompt already says these are `low` or `medium`, but severity is the model's
 * own field and it is what the merge gate reads. Left uncapped, one enthusiastic
 * `critical` on a hand-rolled helper fails a pull request that has no defect in
 * it, which is not what anyone sets `fail-on-severity` up to catch.
 */
const OVER_ENGINEERING_CEILING: Severity = 'medium';

function capOverEngineering(finding: Finding): Finding {
  if (finding.category !== 'over-engineering') return finding;
  if (!severityAtLeast(finding.severity, 'high')) return finding;
  core.info(
    `Capping ${finding.path}:${finding.line} from ${finding.severity} to ${OVER_ENGINEERING_CEILING}: ` +
      'over-engineering is maintenance cost, not breakage, and does not gate a merge.',
  );
  return { ...finding, severity: OVER_ENGINEERING_CEILING };
}

/**
 * Whether the model actually wrote anything in this finding.
 *
 * `title` and `body` are required by the schema and typed `string`, and an empty
 * string satisfies both — so a response can carry a finding that says nothing at
 * all, and every check between here and GitHub passes it. Rendered, it is its own
 * header and no more: `**Medium · correctness** — `. Counted, it fails a merge
 * gate on a claim that was never made, and neither remedy applies — there is
 * nothing to change, and a waiver is a statement that a specific claim was
 * considered, which cannot honestly be written about an empty one.
 *
 * A blank `title` is disqualifying for a second reason: the fingerprint is keyed
 * on it, so every textless finding in a file collapses to one id, which is what
 * duplicate suppression and dismissals both read.
 *
 * Dropped rather than failing the batch: the rest of the review is unaffected,
 * and one empty finding is not a reason to discard the findings that do say
 * something.
 */
function hasText(finding: Finding): boolean {
  return finding.title.trim().length > 0 && finding.body.trim().length > 0;
}

/**
 * Resolve a finding to a line range GitHub will accept, or null.
 *
 * A review POST fails as a whole with 422 if any single comment anchors outside
 * the diff, so this has to be strict: every line in the range must appear in the
 * patch, which also keeps the range inside one hunk.
 */
export function resolveAnchor(finding: Finding, file: DiffFile): { line: number; startLine?: number } | null {
  const start = finding.line;
  const end = finding.end_line ?? finding.line;
  if (!Number.isInteger(start) || start < 1) return null;
  if (!file.commentableLines.has(start)) return null;

  if (end <= start || end - start > MAX_ANCHOR_SPAN) {
    return { line: start };
  }
  for (let l = start; l <= end; l++) {
    if (!file.commentableLines.has(l)) return { line: start };
  }
  return { line: end, startLine: start };
}

/**
 * The finding as it will be published, with a suggestion that cannot change the
 * lines it replaces taken off it.
 *
 * Judged here because this is where both halves are in hand: the anchor has just
 * been resolved, and the file's patch carries the text of the lines it points at.
 * The finding itself is published either way — what the screen withholds is the
 * one-click answer, not the argument.
 */
function withoutNoOpSuggestion(
  finding: Finding,
  file: DiffFile,
  anchor: { line: number; startLine?: number },
): Finding {
  if (!finding.suggestion?.trim()) return finding;

  const { lines } = parsePatch(file.patch);
  const anchored: string[] = [];
  for (let line = anchor.startLine ?? anchor.line; line <= anchor.line; line++) {
    const text = lines.get(line);
    // The patch does not render this line, so there is nothing to compare the
    // replacement against and nothing is claimed about it.
    if (text === undefined) return finding;
    anchored.push(text);
  }

  const reason = screenSuggestion(finding.suggestion, anchored);
  if (!reason) return finding;

  core.warning(
    `Withheld the suggestion on ${finding.path}:${finding.line}: ${reason}. ` +
      'The finding itself is posted as written.',
  );
  return { ...finding, suggestion: null };
}

function renderComment(finding: Finding): string {
  const parts = [
    `**${SEVERITY_LABEL[finding.severity]} · ${finding.category}** — ${finding.title}`,
    '',
    finding.body.trim(),
  ];
  if (finding.suggestion && finding.suggestion.trim()) {
    parts.push('', '```suggestion', finding.suggestion.replace(/\s+$/, ''), '```');
  }
  parts.push('', marker('finding', findingFingerprint(finding.path, finding.category, finding.title)));
  return parts.join('\n');
}

/**
 * The one line that says whether this check passed, written where the reviewer
 * already is. Without it the verdict lived only in step outputs and the job
 * summary, so a gate that was never switched on looked identical to one that
 * was switched on and found nothing.
 */
function renderVerdict(
  highest: Severity | null,
  cfg: Config,
  incomplete: boolean,
  dismissed: DismissedFinding[],
  /** How many findings the model returned that nothing below will report. */
  dropped: number,
): string {
  // "Nothing found" and "5 findings filtered out" were both printed in one
  // comment, the first at the top and the second in the footer, and the
  // collapsed view shows only the first. They are different claims: one says the
  // model came back empty, the other says it came back with things that did not
  // clear this run's severity and confidence floors. Whoever stops reading at
  // the verdict line has to get the true one.
  const found = highest
    ? `Highest severity found: **${SEVERITY_LABEL[highest]}**.`
    : dropped
      ? `Nothing above the reporting bar (${dropped} finding${dropped === 1 ? '' : 's'} filtered out).`
      : 'Nothing found.';
  // A check that is only green because someone waived a finding has to say so on
  // the pull request, or the waiver is invisible to whoever approves it.
  const waived = dismissed.length
    ? ` ${dismissed.length} finding${dismissed.length === 1 ? '' : 's'} waived by a reviewer, listed below.`
    : '';

  if (cfg.failOnSeverity === 'none') {
    return `${found} Not gating — \`fail-on-severity\` is not set, so this check passes whatever is found.${waived}`;
  }
  if (highest && severityAtLeast(highest, cfg.failOnSeverity)) {
    return `❌ **Failed.** ${found} At or above the \`${cfg.failOnSeverity}\` threshold.${waived}`;
  }
  if (incomplete) {
    return `❌ **Failed.** ${found} Part of the diff could not be reviewed, so the result cannot be trusted as a gate.${waived}`;
  }
  return `✅ **Passed.** ${found} Below the \`${cfg.failOnSeverity}\` threshold.${waived}`;
}

/**
 * How to report a bug in Hawky itself, written as much for the coding agents that
 * read these comments as for people. It is collapsed but in plain sight rather
 * than in an HTML comment: an agent is right to distrust instructions it cannot
 * show its user, so this asks it to check with them instead of telling it to
 * file. Most of it is about what to leave out, because Hawky's tracker is public
 * and the repository under review often is not.
 */
function renderBugReport(cfg: Config): string[] {
  const model = `${cfg.provider}/${cfg.model}`;
  const settings = [
    `mode ${cfg.mode}`,
    `fail-on-severity ${cfg.failOnSeverity}`,
    `dismissals ${cfg.dismissals}`,
  ].join(', ');
  // Field ids from .github/ISSUE_TEMPLATE/bug-report.yml, which GitHub pre-fills
  // from the query. A literal '+' is already escaped, so every '+' is a space.
  const query = new URLSearchParams({ template: 'bug-report.yml', version: pkg.version, model, settings });
  const link = `https://github.com/${HAWKY_REPO}/issues/new?${query.toString().replace(/\+/g, '%20')}`;
  const disagree = cfg.dismissals === 'off' ? '' : ' (for those, reply `@hawky ignore <reason>`)';

  return [
    '<details><summary><sub>Is Hawky itself broken? Report it</sub></summary>',
    '',
    `This is for bugs in Hawky, not disagreements with a finding${disagree}. For example: a comment on ` +
      "the wrong line, garbled or cut-off text, the model's reasoning in a comment, the same comment " +
      'posted again after a push, or a verdict that contradicts the findings.',
    '',
    `[Open a bug report](${link}) with the version and settings filled in.`,
    '',
    '**If you are a coding agent:** tell your user what you saw, and ask before filing. With their go-ahead:',
    '',
    `1. Look for an existing report first: \`gh issue list --repo ${HAWKY_REPO} --state all --search "<symptom>"\`. ` +
      'If one matches, comment what is new there instead of filing again.',
    `2. File it with \`gh issue create --repo ${HAWKY_REPO} --title "<symptom>" --body "<report>"\`. The report gives:`,
    `   - Hawky ${pkg.version}, ${model}, ${settings}`,
    '   - the finding id, if the bug concerns one finding: the 16-digit hex id in the hidden ' +
      '`<!-- hawky:… -->` marker at the end of its comment, or beside it in this summary',
    '   - what happened, and what you expected instead',
    '   - the line `Filed by a coding agent on behalf of its user.`',
    "3. Leave this pull request out of it. Hawky's issue tracker is public and this repository may not be: " +
      'no code, diffs, file paths, comment text, or repository and organization names. ' +
      'Describe the shape of the problem, or write a minimal repro from scratch.',
    '',
    '</details>',
    '',
  ];
}

/**
 * The model's own prose, quoted rather than spoken in Hawky's voice.
 *
 * Everything else in this comment is constructed from fields this action
 * computed — the verdict, the counts, the filtered tally — and a run arrived
 * proving the difference matters: the structured parts were all correct while
 * `summary` carried a block of another project's context, ending in instructions
 * addressed to an assistant, rendered at the top of the comment above the
 * verdict, in Hawky's voice.
 *
 * These comments are read by coding agents as well as by people; the bug-report
 * section below is written to them directly. Text reaching that audience unmarked
 * and in the tool's own voice is text the tool is vouching for. Quoting it under
 * an attribution does not make the content safe — nothing here can — but it makes
 * the provenance legible, which is the part Hawky is actually able to be
 * responsible for. The verdict and the counts come first, so what the run can
 * stand behind is what gets read first.
 */
function renderModelSummary(summary: ReviewSummary, cfg: Config): string[] {
  const lines: string[] = [];
  const text = summary.text.trim();

  if (text) {
    lines.push(
      `**Summary** — \`${cfg.provider}/${cfg.model}\` wrote this, quoted as given:`,
      '',
      // Every line prefixed, blank ones included, so the whole block stays inside
      // the quote instead of ending it partway down.
      ...text.split('\n').map((line) => (line.trim() ? `> ${line}` : '>')),
      '',
    );
  }

  // Said rather than passed over in silence: a reader comparing this comment to
  // the run log should not have to wonder why the model's description is missing.
  for (const reason of new Set(summary.withheld)) {
    lines.push(`_A summary the model wrote was withheld: ${reason}._`, '');
  }

  return lines;
}

/** What this run held back, for the tally at the foot of the summary. */
interface FilteredCounts {
  /** How many findings the model returned that nothing in the review will report. */
  dropped: number;
  /** How many of `dropped` went because their line was not in the diff at all. */
  misanchored: number;
  /** How many of `dropped` went because the model wrote nothing in them. */
  textless: number;
  /** How many of `dropped` went because their text could not describe the diff. */
  degenerate: number;
  /** How many of `dropped` were a claim this same run had already made. */
  duplicates: number;
}

function renderSummary(
  summary: ReviewSummary,
  posted: Finding[],
  unanchored: Finding[],
  dismissed: DismissedFinding[],
  cfg: Config,
  counts: FilteredCounts,
  highest: Severity | null,
  incomplete: boolean,
  /** True when the diff is large enough that one pass is a sample of it. */
  sampled: boolean,
): string {
  const { dropped, misanchored, textless, degenerate, duplicates } = counts;
  const lines = [
    SUMMARY_MARKER,
    '## Hawky review',
    '',
    renderVerdict(highest, cfg, incomplete, dismissed, dropped),
    '',
  ];

  // Only where it changes what the verdict means. A run that found something is
  // already telling the author to push again, and the next push re-reviews.
  if (sampled && highest === null) {
    lines.push(
      '_Reviewed in one pass. On a diff this size a single pass samples the defects rather than enumerating ' +
        'them, and a later run over the same code may still find something — so this is "nothing found this ' +
        'time" rather than an all-clear._',
      '',
    );
  }

  if (posted.length) {
    const counts = new Map<Severity, number>();
    for (const f of posted) counts.set(f.severity, (counts.get(f.severity) ?? 0) + 1);
    const breakdown = (['critical', 'high', 'medium', 'low'] as Severity[])
      .filter((s) => counts.has(s))
      .map((s) => `${counts.get(s)} ${s}`)
      .join(', ');
    lines.push(`Left ${posted.length} inline comment${posted.length === 1 ? '' : 's'} (${breakdown}).`, '');
  } else {
    lines.push('No new inline comments.', '');
  }

  lines.push(...renderModelSummary(summary, cfg));

  if (unanchored.length) {
    lines.push(
      '<details><summary>Findings that could not be anchored to a changed line</summary>',
      '',
    );
    for (const f of unanchored) {
      // The id is the only handle on these: there is no thread to reply in, so a
      // false positive here can only be waived by naming it.
      const id = findingFingerprint(f.path, f.category, f.title);
      lines.push(
        `- **${f.path}:${f.line}** — ${SEVERITY_LABEL[f.severity]} · ${f.title} \`${id}\``,
        '',
        `  ${f.body.trim().replace(/\n/g, '\n  ')}`,
        '',
      );
    }
    lines.push('</details>', '');
  }

  if (dismissed.length) {
    lines.push(
      `<details><summary>${dismissed.length} finding${dismissed.length === 1 ? '' : 's'} waived by a reviewer</summary>`,
      '',
    );
    for (const { finding: f, dismissal: d, rewordingOf } of dismissed) {
      const how = d.via === 'resolved' ? 'resolved the thread' : 'waived it';
      lines.push(
        `- **${f.path}:${f.line}** — ${SEVERITY_LABEL[f.severity]} · ${f.title}` +
          ` — @${d.by} ${how}: ${d.reason}` +
          // Said outright rather than folded in silently: this one was not waived
          // on its own thread, and a reader has to be able to disagree with the match.
          (rewordingOf ? `\n  <sub>Held back as a rewording of a finding waived here: “${rewordingOf}”.</sub>` : ''),
      );
    }
    lines.push(
      '',
      'These do not gate the merge. Reverse one by deleting the comment that waived it ' +
        '(or unresolving its thread) and re-running this check.' +
        (dismissed.some((d) => d.rewordingOf)
          ? ' One held back as a rewording is reversed the same way, by the waiver it was matched to.'
          : ''),
      '',
      '</details>',
      '',
    );
  }

  if (dropped) {
    // Named apart from the rest: these went as unreliable or as empty, which is
    // not the same claim as "real but below the bar".
    const named = [
      misanchored ? `${misanchored} that did not anchor to a changed line` : '',
      textless ? `${textless} the model left empty` : '',
      degenerate ? `${degenerate} whose text could not describe this diff` : '',
      duplicates ? `${duplicates} the model reported twice in one run` : '',
    ].filter(Boolean);
    const list =
      named.length <= 2
        ? named.join(' and ')
        : `${named.slice(0, -1).join(', ')} and ${named[named.length - 1]}`;
    lines.push(
      `_${dropped} lower-signal finding${dropped === 1 ? '' : 's'} filtered out ` +
        `(below \`${cfg.minSeverity}\` severity or \`${cfg.minConfidence}\` confidence, or already commented on)` +
        (named.length ? `, including ${list}` : '') +
        '._',
      '',
    );
  }

  if (cfg.dismissals !== 'off') {
    lines.push(
      '<sub>Wrong about something? Reply `@hawky ignore <reason>` in its thread' +
        (cfg.dismissals === 'all' ? ', or resolve the thread,' : '') +
        ' and re-run this check.</sub>',
      '',
    );
  }

  if (cfg.bugReportFooter) lines.push(...renderBugReport(cfg));

  lines.push(`<sub>Reviewed by ${cfg.provider}/${cfg.model}. Re-run by pushing a commit.</sub>`);
  return lines.join('\n');
}

type IssueComment = { id: number; body?: string | null };

async function listIssueComments(
  octokit: Octokit,
  owner: string,
  repo: string,
  issue_number: number,
): Promise<IssueComment[]> {
  return (await octokit.paginate(octokit.rest.issues.listComments, {
    owner,
    repo,
    issue_number,
    per_page: 100,
  })) as IssueComment[];
}

async function upsertSummary(
  octokit: Octokit,
  owner: string,
  repo: string,
  issue_number: number,
  comments: IssueComment[],
  body: string,
): Promise<void> {
  const existing = comments.find((c) => c.body?.includes(SUMMARY_MARKER));

  if (existing) {
    await octokit.rest.issues.updateComment({ owner, repo, comment_id: existing.id, body });
    core.info(`Updated summary comment #${existing.id}.`);
  } else {
    await octokit.rest.issues.createComment({ owner, repo, issue_number, body });
    core.info('Posted summary comment.');
  }
}

/** What this pull request already says about earlier runs, read once per run. */
export interface ReviewContext {
  issueComments: IssueComment[];
  state: ThreadState;
}

/**
 * Read the conversation so far.
 *
 * Split out of the posting step because it is needed at both ends of a run: the
 * prompt has to be told what has already been decided here, which happens before
 * the model is called, and the same answer decides what gets posted afterwards.
 * Reading it twice would mean two rounds of API calls and two copies of every
 * warning about a malformed waiver.
 */
export async function readReviewContext(
  octokit: Octokit,
  owner: string,
  repo: string,
  pull_number: number,
  cfg: Config,
): Promise<ReviewContext> {
  // Nothing is posted on a rehearsal, so there is nothing to deduplicate against.
  if (cfg.dryRun) {
    return { issueComments: [], state: { seen: new Set(), dismissed: new Map<string, Dismissal>(), prior: [] } };
  }
  const issueComments = await listIssueComments(octokit, owner, repo, pull_number);
  const state = await readThreadState(octokit, owner, repo, pull_number, issueComments, cfg.dismissals);
  return { issueComments, state };
}

export async function postReview(
  octokit: Octokit,
  owner: string,
  repo: string,
  pull_number: number,
  commit_id: string,
  summary: ReviewSummary,
  findings: Finding[],
  files: DiffFile[],
  cfg: Config,
  /** Some of the diff could not be reviewed and the run is configured to fail on that. */
  incomplete = false,
  /** The conversation as the run already read it; read here when not supplied. */
  context?: ReviewContext,
): Promise<PostedReview> {
  const byPath = new Map(files.map((f) => [f.path, f]));
  const { issueComments, state } = context ?? (await readReviewContext(octokit, owner, repo, pull_number, cfg));
  const { seen: alreadyPosted, dismissed: waived, prior } = state;

  const before = findings.length;

  // Judged before anything else looks at these: a finding with no text cannot be
  // read, cannot be acted on, and cannot honestly be waived, so it must not reach
  // a comment or the gate. Warned about individually because an empty finding is
  // a defect in the response, not a routine filtering decision.
  const written: Finding[] = [];
  for (const f of findings) {
    if (hasText(f)) {
      written.push(f);
      continue;
    }
    core.warning(
      `Discarded ${f.severity} ${f.path}:${f.line}: the model returned a finding with no ` +
        `${f.title.trim() ? 'description' : 'title or description'}, which makes no claim anyone could act on.`,
    );
  }
  const textless = before - written.length;

  // Judged next, and for the same reason: a finding whose text cannot be true of
  // any diff is not a finding, and at `fail-on-severity: medium` one of them is
  // enough to stop a merge. Neither remedy applies to it — there is no code to
  // change, and a waiver is a statement that a specific claim was considered,
  // which cannot honestly be written about a claim that says nothing. Warned
  // about individually, like an empty finding: this is a defect in the response,
  // not a routine filtering decision.
  const describing: Finding[] = [];
  for (const f of written) {
    const reason = screenFinding(f, byPath.get(f.path)?.patch ?? '');
    if (!reason) {
      describing.push(f);
      continue;
    }
    core.warning(
      `Discarded ${f.severity} ${f.path}:${f.line}: ${reason}. It is not reported and does not gate the merge.`,
    );
  }
  const degenerate = written.length - describing.length;

  const qualified = describing
    .filter((f) => byPath.has(f.path))
    .map(capOverEngineering)
    .filter((f) => severityAtLeast(f.severity, cfg.minSeverity))
    .filter((f) => (f.confidence ?? 0) >= cfg.minConfidence)
    .sort(
      (a, b) =>
        SEVERITY_ORDER[b.severity] - SEVERITY_ORDER[a.severity] || (b.confidence ?? 0) - (a.confidence ?? 0),
    );

  // A run can report the same finding twice. Batching is per-request, so one
  // file's lines can be read in two calls — a file split across a batch boundary,
  // or a name that two batches both have reason to comment on — and each call
  // answers on its own. Both copies carried the same fingerprint, the same hidden
  // marker, and the same severity, and both were posted a few lines apart, because
  // the only duplicate check there was compared this run against the *pull
  // request* rather than against itself.
  //
  // Same key as that cross-run check, so the two agree by construction: same path,
  // same category, same title is the same finding. The first copy is kept — the
  // list is already sorted by severity and then confidence, so it is the strongest
  // statement of the claim.
  const unique: Finding[] = [];
  const saidThisRun = new Set<string>();
  for (const f of qualified) {
    const fingerprint = findingFingerprint(f.path, f.category, f.title);
    if (saidThisRun.has(fingerprint)) {
      core.info(`Suppressed a second copy of ${f.path}:${f.line} ${fingerprint}: this run already reported it.`);
      continue;
    }
    saidThisRun.add(fingerprint);
    unique.push(f);
  }
  const duplicates = qualified.length - unique.length;

  // A waived finding leaves the run entirely: it does not gate, and it is not
  // reposted either, so re-reviewing does not resurrect the argument.
  //
  // Recognised by fingerprint first and by wording second. The fingerprint is keyed
  // on the title, and the title is model prose written afresh on every run, so the
  // exact match alone let a rejected claim return under a new id as often as the
  // model cared to rephrase itself: one claim came back seven times on a single
  // pull request, gating the merge each time. The wording match is confined to
  // findings waived on the same file, and what it catches is reported as a match
  // rather than quietly swallowed.
  const waivedHere = prior.filter((p) => p.dismissal);
  const waiverFor = (f: Finding): { dismissal: Dismissal; rewordingOf?: string } | null => {
    const exact = waived.get(findingFingerprint(f.path, f.category, f.title));
    if (exact) return { dismissal: exact };
    const near = waivedHere.find((p) => p.path === f.path && sameClaim(p.title, f.title));
    return near?.dismissal ? { dismissal: near.dismissal, rewordingOf: near.title } : null;
  };

  const dismissed: DismissedFinding[] = [];
  const active: Finding[] = [];
  for (const f of unique) {
    const waiver = waiverFor(f);
    if (!waiver) {
      active.push(f);
      continue;
    }
    if (waiver.rewordingOf) {
      core.info(
        `Held back ${f.severity} ${f.path}:${f.line} — ${f.title}: it restates a finding ` +
          `@${waiver.dismissal.by} already waived on this file.`,
      );
    }
    dismissed.push({ finding: f, dismissal: waiver.dismissal, rewordingOf: waiver.rewordingOf });
  }

  // A finding whose line is nowhere in the diff is the strongest evidence there is
  // that the model misread its partial view of the file and invented the location.
  // It leaves the run: published, it is the review talking about code that is not
  // there, and gating on it fails a merge over a hallucination. Judged here rather
  // than in the posting loop below because anchorability is a property of the
  // finding, not of whether this particular run happens to be posting it.
  const anchorable: Finding[] = [];
  for (const f of active) {
    if (resolveAnchor(f, byPath.get(f.path)!)) {
      anchorable.push(f);
      continue;
    }
    core.warning(
      `Discarded ${f.severity} ${f.path}:${f.line} — ${f.title}: line ${f.line} is not part of the diff, ` +
        'so the finding does not describe a line this pull request changed.',
    );
  }
  const misanchored = active.length - anchorable.length;

  const kept = anchorable
    .filter((f) => !alreadyPosted.has(findingFingerprint(f.path, f.category, f.title)))
    .slice(0, cfg.maxComments);

  const posted: Finding[] = [];
  const unanchored: Finding[] = [];
  const comments: Array<Record<string, unknown>> = [];

  for (const finding of kept) {
    const file = byPath.get(finding.path)!;
    // Cannot be null: everything in `kept` came through the anchorable filter above.
    const anchor = resolveAnchor(finding, file)!;
    const published = withoutNoOpSuggestion(finding, file, anchor);
    posted.push(published);
    comments.push({
      path: published.path,
      body: renderComment(published),
      side: 'RIGHT',
      line: anchor.line,
      ...(anchor.startLine ? { start_line: anchor.startLine, start_side: 'RIGHT' } : {}),
    });
  }

  // Waived findings are reported in their own section, so they must not also be
  // counted among the ones quietly filtered out.
  const dropped = before - posted.length - unanchored.length - dismissed.length;

  // Gate on everything that survived the quality filters and anchored to a line
  // this pull request actually changed, whether or not GitHub accepted the inline
  // comment and whether or not an earlier run already commented on it: an
  // unresolved critical finding is still critical on the second push.
  const highestSeverity = anchorable.reduce<Severity | null>(
    (acc, f) => (acc === null || SEVERITY_ORDER[f.severity] > SEVERITY_ORDER[acc] ? f.severity : acc),
    null,
  );

  const counts: FilteredCounts = { dropped, misanchored, textless, degenerate, duplicates };
  const sampled = files.length >= SAMPLED_FROM_FILES;
  const summaryBody = renderSummary(
    summary,
    posted,
    unanchored,
    dismissed,
    cfg,
    counts,
    highestSeverity,
    incomplete,
    sampled,
  );

  if (cfg.dryRun) {
    core.info('[dry-run] Would post the following review:');
    core.info(summaryBody);
    for (const c of comments) core.info(JSON.stringify(c, null, 2));
    return { posted, unanchored, dismissed, highestSeverity };
  }

  if (comments.length) {
    try {
      await octokit.rest.pulls.createReview({
        owner,
        repo,
        pull_number,
        commit_id,
        event: 'COMMENT',
        body: `${comments.length} new comment${comments.length === 1 ? '' : 's'} from Hawky. See the summary below.`,
        comments: comments as never,
      });
      core.info(`Posted ${comments.length} inline comment(s).`);
    } catch (err) {
      // One bad anchor rejects the whole review. Rather than lose the review,
      // fold everything into the summary comment.
      core.warning(
        `Could not post inline comments (${(err as Error).message}). Including them in the summary instead.`,
      );
      unanchored.push(...posted);
      posted.length = 0;
      await upsertSummary(
        octokit,
        owner,
        repo,
        pull_number,
        issueComments,
        renderSummary(summary, [], unanchored, dismissed, cfg, counts, highestSeverity, incomplete, sampled),
      );
      return { posted, unanchored, dismissed, highestSeverity };
    }
  }

  await upsertSummary(octokit, owner, repo, pull_number, issueComments, summaryBody);
  return { posted, unanchored, dismissed, highestSeverity };
}
