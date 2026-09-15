import type { Config, Mode, Ponytail } from './config.js';
import type { DiffFile } from './types.js';
import type { Target } from './gh/client.js';

/**
 * What each intensity level changes about how much the reviewer cuts. Taken from
 * the `ponytail` skill, which grades the same ladder from "mention the lazier
 * option" up to "argue the code should not exist".
 */
const PONYTAIL_INTENSITY: Record<Exclude<Ponytail, 'off'>, string> = {
  lite:
    'Intensity: lite. Raise only the clearest case in a file, and frame it as the lazier alternative rather ' +
    'than a defect. The author decides. If you would not delete it yourself, do not raise it.',
  full:
    'Intensity: full. The ladder enforced. Anything that fails a rung is a finding, but stay on things worth ' +
    'the author\'s time to change.',
  ultra:
    'Intensity: ultra. Deletion before addition. Challenge whether the added code needs to exist at all, not ' +
    'just whether it could be shorter, and say so even when the answer is that the feature itself is speculative.',
};

/**
 * The over-engineering pass, from the `ponytail` skill: what the change could
 * simply not have. It is deliberately a separate section rather than more items
 * under `## Rules`, because it asks a different question than the rest of the
 * review — not "is this wrong" but "does this need to exist".
 */
function ponytailSection(level: Exclude<Ponytail, 'off'>, wantsFindings: boolean): string[] {
  const parts = [
    ``,
    `## Over-engineering`,
    ``,
    `You are also a lazy senior engineer: the best code is the code that was never written. For each added`,
    `block, climb this ladder and stop at the first rung that holds. Anything that fails a rung is worth`,
    `reporting.`,
    ``,
    `1. Does this need to exist at all? A speculative need is not a need. (YAGNI)`,
    `2. Is it already in this codebase? A helper, type, or pattern that already lives here should be reused.`,
    `   Re-implementing what sits a few files over is the most common form of this.`,
    `3. Does the standard library do it? Name the function.`,
    `4. Does a native platform feature cover it? A built-in input type over a picker library, CSS over JS,`,
    `   a database constraint over application code.`,
    `5. Does an already-installed dependency solve it? A new dependency for what a few lines do is never worth it.`,
    `6. Can it be one line?`,
    `7. Only then: the minimum code that works.`,
    ``,
    `Never propose cutting these, however much code they cost: validation at a trust boundary, error handling`,
    `that prevents data loss, a security measure, an accessibility basic, or the one test or self-check that`,
    `fails when the logic breaks. Anything the pull request description explicitly asks for was requested, not`,
    `speculated — leave it alone, and do not re-argue a simplification the author has already declined.`,
    ``,
    `This is about deleting code, not renaming it. The no-style rule above still holds.`,
    ``,
    PONYTAIL_INTENSITY[level],
  ];

  if (!wantsFindings) return parts;

  parts.push(
    ``,
    `Report each one as a finding with \`category\` set to \`over-engineering\` and one of these tags at the`,
    `front of the \`title\`:`,
    ``,
    `- \`delete:\` dead code, unused flexibility, a speculative feature. Nothing replaces it.`,
    `- \`stdlib:\` a hand-rolled version of something the standard library ships. Name the function.`,
    `- \`native:\` code or a dependency doing what the platform already does. Name the feature.`,
    `- \`yagni:\` an abstraction with one implementation, config nobody sets, a layer with one caller.`,
    `- \`shrink:\` the same logic in fewer lines. Show the shorter form.`,
    ``,
    `The \`body\` says what to cut and what replaces it, in one or two sentences, and ends with the lines it`,
    `saves, like \`net: -18 lines\`. No paragraph defending the simplification: prose arguing for less code is`,
    `more complexity, not less. Put the shorter form in \`suggestion\` whenever it fits the anchored lines.`,
    ``,
    `Severity for these is \`low\` or \`medium\`, never \`high\` or \`critical\`. Over-engineering is maintenance`,
    `cost, not breakage, and it must not fail a merge gate that exists to catch defects. Judge \`confidence\` on`,
    `whether the replacement genuinely works, not on how strongly you dislike the code.`,
  );
  return parts;
}

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
    );
    if (cfg.ponytail !== 'off') {
      parts.push(
        `Prefer the ones that end with less code than they started with. A refactor that deletes a layer beats one`,
        `that adds a better layer.`,
        ``,
      );
    }
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

  if (cfg.ponytail !== 'off') {
    parts.push(...ponytailSection(cfg.ponytail, wantsFindings));
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

export function buildUserPrompt(
  target: Target,
  files: DiffFile[],
  batchIndex: number,
  batchCount: number,
  /** Paths this change touched that are not in `files`; see `Diff.omitted`. */
  omitted: string[],
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
