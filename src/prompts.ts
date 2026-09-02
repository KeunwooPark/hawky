import type { Config, Mode } from './config.js';
import type { DiffFile } from './types.js';
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
    );
  }
  if (wantsRefactors) {
    parts.push(
      `Report structural problems the change exposes: duplicated logic, a function or module that has outgrown its`,
      `responsibility, an abstraction that is leaking, a pattern being copied for the third time. These become`,
      `tracked issues, not inline comments, so only raise ones worth a separate piece of work.`,
      ``,
    );
  }

  parts.push(
    `## Rules`,
    ``,
    `- Anchor every finding to a line marked \`+\` in the diff. The number in the left gutter is the line number to use.`,
    `  Never anchor to an unchanged context line, and never invent a line number.`,
    `- You are reading a partial view of the codebase. If a symbol, import, or caller is not shown, assume it exists and`,
    `  is correct. Do not report something as missing or undefined when it is simply outside the diff.`,
    `- Report a problem only if you can name the input or state that triggers it and the resulting behaviour. If you`,
    `  cannot, drop it.`,
    `- Set \`confidence\` honestly. Below 0.6 means you are guessing; that finding will be discarded, which is the`,
    `  correct outcome for a guess.`,
    `- No style, formatting, naming, or comment-density opinions unless the project guidelines below ask for them.`,
    `  Linters and formatters already handle those and the author does not want them from you.`,
    `- No praise, no summary of what the code does, no "consider adding tests" boilerplate. If a specific untested`,
    `  branch will break, say which branch and why.`,
    `- One finding per distinct problem. Do not repeat the same issue across several lines; report it once at the`,
    `  clearest location.`,
    `- Every field holds a finished answer, not your working-out. Do not narrate your deliberation, weigh options`,
    `  against each other, or trail off mid-thought inside a \`body\`. If you have not reached a conclusion, the`,
    `  finding does not go in.`,
    `- Prefer few high-signal findings over many. An empty \`findings\` array is a perfectly good review of a clean change.`,
    `- When you provide a \`suggestion\`, it must be the complete replacement text for the lines you anchored to,`,
    `  keeping the surrounding indentation, so it can be applied directly.`,
  );

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
    `   42 +  const x = compute();   <- added line 42, you may comment here`,
    `   43    return x;              <- unchanged context line 43, do not comment here`,
    `      -  const y = old();       <- removed line, no line number`,
    `\`\`\``,
    ``,
    `Respond with JSON matching the required schema and nothing else.`,
  );

  return parts.join('\n');
}

export function buildUserPrompt(
  target: Target,
  files: DiffFile[],
  batchIndex: number,
  batchCount: number,
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
