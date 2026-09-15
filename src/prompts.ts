import type { Config, Mode } from './config.js';
import type { DiffFile, PriorDefinition } from './types.js';
import type { Target } from './gh/client.js';

/**
 * The system prompt is deliberately identical across every batch in a run so it
 * can be cached by the provider. Anything that varies per batch belongs in the
 * user message.
 */
export function buildSystemPrompt(cfg: Config, mode: Mode): string {
  const wantsFindings = mode !== 'refactor';
  const wantsRefactors = mode !== 'review';

  const parts: string[] = [
    `You are a senior engineer reviewing a pull request. You see only the changed hunks, not the whole repository.`,
    ``,
    `## What to report`,
    ``,
  ];

  if (wantsFindings) {
    parts.push(
      `Report defects in the added lines: logic errors, unhandled failure modes, race conditions, resource leaks,`,
      `security problems, off-by-one and boundary mistakes, incorrect error handling, API misuse, and changes that`,
      `silently break existing callers. Anchor each one to the exact line that has to change.`,
      ``,
      // Over-engineering is part of what a review is, rather than a pass bolted on
      // after the rules: the questions it asks are asked of the same added lines, by
      // the same reviewer, and answered with the same evidence.
      `Report code the change could simply not have. The best code is the code that was never written, so ask`,
      `this of each added block:`,
      ``,
      `- Is it already in this repository? A helper, type, or pattern that already lives here should be reused.`,
      `  Re-implementing what sits a few files over is the most common form of this. Point to the one that`,
      `  already exists; if you cannot point to it, there is nothing to report.`,
      `- Can it be one line?`,
      `- Is it more than the minimum code that works?`,
      ``,
      `Never propose cutting these, however much code they cost: validation at a trust boundary, error handling`,
      `that prevents data loss, a security measure, an accessibility basic, or the one test or self-check that`,
      `fails when the logic breaks. Anything the pull request description explicitly asks for was requested, not`,
      `speculated — leave it alone, and do not re-argue a simplification the author has already declined.`,
      ``,
      `This is about deleting code, not renaming it. The no-style rule below still holds.`,
      ``,
      `Report each one as a finding with \`category\` set to \`over-engineering\` and one of these tags at the`,
      `front of the \`title\`:`,
      ``,
      `- \`reuse:\` a name or pattern this repository already defines. Name where it already lives.`,
      `- \`shrink:\` the same logic in less code. Show the shorter form.`,
      ``,
      `The \`body\` says what to cut and what replaces it, in one or two sentences, and ends with the lines it`,
      `saves, like \`net: -18 lines\`. No paragraph defending the simplification: prose arguing for less code is`,
      `more complexity, not less. Put the shorter form in \`suggestion\` whenever it fits the anchored lines.`,
      ``,
      `Severity for these is \`low\` or \`medium\`, never \`high\` or \`critical\`. Over-engineering is maintenance`,
      `cost, not breakage, and it must not fail a merge gate that exists to catch defects. Judge \`confidence\` on`,
      `whether the replacement genuinely works, not on how strongly you dislike the code.`,
      ``,
    );
  }
  if (wantsRefactors) {
    parts.push(
      `Report structural problems the change exposes: duplicated logic, a function or module that has outgrown its`,
      `responsibility, an abstraction that is leaking, a pattern being copied for the third time. These become`,
      `tracked issues, not inline comments, so only raise ones worth a separate piece of work. At most`,
      `${cfg.maxIssues} issue(s) are opened on this run and the rest are discarded unread, so send the ones`,
      `that earn a separate piece of work rather than everything the change suggests.`,
      ``,
      `Prefer the ones that end with less code than they started with. A refactor that deletes a layer beats one`,
      `that adds a better layer.`,
      ``,
    );
  }

  // Rules naming a field only a `Finding` has are gated on `wantsFindings`. A
  // refactor-only run produces no findings, so asking it to weigh a `confidence` or
  // anchor to a `+` line is a contract for output it must not send.
  parts.push(`## Rules`, ``);

  if (wantsFindings) {
    parts.push(
      `- Anchor every finding to a line marked \`+\` in the diff. The number in the left gutter is the line number to use.`,
      `  Never anchor to an unchanged context line, and never invent a line number.`,
    );
  }

  parts.push(
    `- You are reading a partial view of the codebase. If a symbol, import, or caller is not shown, assume it exists and`,
    `  is correct. Do not report something as missing or undefined when it is simply outside the diff.`,
  );

  if (wantsFindings) {
    parts.push(
      `- Report a defect only if you can name the input or state that triggers it and the resulting behaviour. If you`,
      `  cannot, drop it.`,
      `- Set \`confidence\` honestly. Anything below ${cfg.minConfidence} is discarded on this run, which is the correct`,
      `  outcome for a guess.`,
    );
  }

  parts.push(
    `- No style, formatting, naming, or comment-density opinions unless the project guidelines below ask for them.`,
    `  Linters and formatters already handle those and the author does not want them from you.`,
  );

  if (wantsFindings) {
    parts.push(
      `- Inside a finding: no praise, no restating what the code does, no "consider adding tests" boilerplate. The`,
      `  top-level \`summary\` field is the one place that describes the change. If a specific untested branch will`,
      `  break, say which branch and why.`,
    );
  }

  parts.push(
    `- Raise each distinct problem once, at the clearest location. Do not repeat the same one across several lines.`,
    `- Every field holds a finished answer, not your working-out. Do not narrate your deliberation, weigh options`,
    `  against each other, or trail off mid-thought inside a \`body\`. If you have not reached a conclusion, it does`,
    `  not go in.`,
    ...(wantsFindings
      ? [
          `- Prefer few high-signal findings over many. An empty \`findings\` array is a perfectly good review of a clean change.`,
        ]
      : [
          `- Prefer few high-signal refactors over many. An empty \`refactors\` array is a perfectly good review of a change`,
          `  that exposes nothing structural.`,
        ]),
  );

  if (wantsFindings) {
    parts.push(
      `- When you provide a \`suggestion\`, it must be the complete replacement text for the lines you anchored to,`,
      `  keeping the surrounding indentation, so it can be applied directly.`,
    );
    // The floor the run actually filters on. Left unsaid, the model spends output on
    // findings that are discarded before anyone reads them.
    if (cfg.minSeverity !== 'low') {
      parts.push(
        `- Findings below \`${cfg.minSeverity}\` severity are discarded on this run. Do not spend output on them.`,
      );
    }
    // The ceiling, for the same reason the floor above is named: a finding the cap
    // drops was still deliberated over in full, and on a model that spends most of
    // its budget thinking, that is the expensive half paid for output nobody reads.
    parts.push(
      `- At most ${cfg.maxComments} finding(s) are posted on this run, taken in order of severity and then`,
      `  confidence. The rest are discarded unread, so decide which ${cfg.maxComments} matter and stop there`,
      `  rather than working up everything you noticed.`,
    );
  } else {
    // The schema requires `findings` in every mode, and this one posts no inline
    // comments: whatever comes back in it is dropped without being read. Left
    // unsaid, that is a mandatory field the model pays for and nobody sees.
    parts.push(
      `- Return \`findings\` as an empty array. The schema requires the field, but this run posts no inline comments`,
      `  and anything in it is discarded — put everything you have to say in \`refactors\` and \`summary\`.`,
    );
  }

  if (cfg.guidelines.trim()) {
    parts.push(
      ``,
      `## Project guidelines`,
      ``,
      `These come from the repository maintainers and take precedence over your defaults:`,
      ``,
      cfg.guidelines.trim(),
    );
  }

  parts.push(
    ``,
    `## Diff format`,
    ``,
    `Each hunk is rendered with head-revision line numbers in the left gutter:`,
    ``,
    `\`\`\``,
    `      @@ -40,3 +42,4 @@         <- hunk header: the lines below it start at line 42`,
    `   42 +  const x = compute();   <- added line 42, you may comment here`,
    `   43    return x;              <- unchanged context line 43, do not comment here`,
    `    -   const y = old();        <- removed line, no line number`,
    `\`\`\``,
    ``,
    `A file arrives as a series of hunks, and the line numbers jump where one hunk ends and the next begins.`,
    `Every line in that gap exists in the file and is simply not shown to you: a hunk starting at line 300 after`,
    `one that ended at line 42 means lines 43 to 299 are real code you cannot see. Imports, definitions, helpers,`,
    `and earlier uses of a variable are usually in those gaps rather than absent, so a symbol you cannot find is`,
    `almost never actually missing. A note that the diff was truncated means the same thing: what it replaced`,
    `exists. Never report a symbol as undefined, uninitialised, unused, or never called on the strength of not`,
    `seeing it here.`,
    ``,
    `Respond with JSON matching the required schema and nothing else.`,
  );

  return parts.join('\n');
}

/**
 * How many withheld paths to name before falling back to a count. The list exists
 * to stop the model calling a symbol undefined, which the first several paths and
 * a total do as well as an exhaustive list would — and a change that touches
 * hundreds of generated files should not spend the batch budget listing them.
 */
const MAX_OMITTED_LISTED = 20;

/**
 * Caps on retrieved definitions, so the answer to the reuse check cannot crowd
 * out the diff it exists to inform. Whichever is reached first ends the list.
 */
const MAX_PRIORS_LISTED = 20;
const MAX_PRIOR_CHARS = 4_000;

export function buildUserPrompt(
  target: Target,
  files: DiffFile[],
  batchIndex: number,
  batchCount: number,
  /** Paths this change touched that are not in `files`; see `Diff.omitted`. */
  omitted: string[],
  /** What this batch defines that the repository already defines elsewhere. */
  priors: PriorDefinition[] = [],
): string {
  const header = [
    `# Pull request`,
    ``,
    `Title: ${target.title || '(none)'}`,
    ``,
    `Description:`,
    target.description.trim() ? target.description.trim().slice(0, 4000) : '(none)',
    ``,
  ];

  if (batchCount > 1) {
    header.push(
      `This is part ${batchIndex + 1} of ${batchCount}. Review only the files below; other files are handled separately.`,
      ``,
    );
  }

  if (omitted.length) {
    const listed = omitted.slice(0, MAX_OMITTED_LISTED);
    header.push(
      `# Changed but not shown`,
      ``,
      `This change also touched the files below and they are not in the diff that follows: they were excluded`,
      `by configuration, are binary, were deleted, or did not fit this run. Whatever they contain is real code.`,
      `Do not report a symbol as missing, undefined, or never used because it is defined in one of these.`,
      ``,
      ...listed.map((p) => `- ${p}`),
      ...(omitted.length > listed.length ? [`- ... and ${omitted.length - listed.length} more`] : []),
      ``,
    );
  }

  if (priors.length) {
    header.push(
      `# Already in this repository`,
      ``,
      `Names this change defines that the checked-out repository already defines somewhere else, found by`,
      `searching it. This is the evidence for the reuse check: two definitions of the same thing is a`,
      `\`reuse:\` finding against the added one. Two different things that happen to share a name is not, so`,
      `read the definition below before reporting it, and say nothing when they are unrelated.`,
      ``,
    );

    let used = 0;
    let listed = 0;
    for (const prior of priors) {
      const entry = [`- \`${prior.name}\` — also defined at ${prior.path}:${prior.line}`, `    ${prior.text}`];
      const cost = entry.join('\n').length + 1;
      if (listed >= MAX_PRIORS_LISTED || used + cost > MAX_PRIOR_CHARS) break;
      header.push(...entry);
      used += cost;
      listed++;
    }
    if (listed < priors.length) header.push(`- ... and ${priors.length - listed} more`);
    header.push(``);
  }

  header.push(`# Changed files`, ``);

  for (const file of files) {
    const renamed = file.previousPath ? ` (renamed from ${file.previousPath})` : '';
    header.push(
      `## ${file.path}${renamed}`,
      `status: ${file.status}, +${file.additions} -${file.deletions}`,
      ``,
      '```diff',
      file.annotated,
      '```',
      ``,
    );
  }

  return header.join('\n');
}
