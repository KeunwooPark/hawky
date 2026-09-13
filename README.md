# Hawky

A GitHub Action that reviews pull requests with an LLM and opens refactoring issues.
Works with the Anthropic API and with any OpenAI-compatible endpoint.

- Inline review comments anchored to the exact changed line, with one-click `suggestion` blocks
- A sticky summary comment that is updated in place instead of piling up
- Refactoring opportunities filed as labelled issues, deduplicated across runs
- An over-engineering pass that asks what the change could simply not have, on by default
- Nothing is reposted when you push again — findings are fingerprinted
- Provider-agnostic: Anthropic, OpenAI, Azure, OpenRouter, Together, Groq, vLLM, Ollama

## Quick start

```yaml
name: Review

on:
  pull_request:
    types: [opened, synchronize, reopened, ready_for_review]

permissions:
  contents: read
  pull-requests: write

jobs:
  review:
    runs-on: ubuntu-latest
    steps:
      - uses: KeunwooPark/hawky@v1
        with:
          api-key: ${{ secrets.ANTHROPIC_API_KEY }}
```

That is the whole setup. No checkout step is needed — the diff comes from the API.

Two things to do first:

1. **Add the API key as a secret.** In the repository you want reviewed, go to
   Settings → Secrets and variables → Actions → New repository secret. Name it
   `ANTHROPIC_API_KEY` (or whatever you reference in `api-key`). Organization-level
   secrets work too, if you are rolling this out across several repositories.
2. **Pin a version.** `@v1` tracks the latest v1.x release and is what most people want.
   `@v1.2.3` pins exactly. `@main` is the development branch and will break you.

### Permissions

The job needs different permissions depending on what you asked for, and a missing one
fails at the point of posting — after the LLM call is already paid for.

| `mode` | Required `permissions` |
| --- | --- |
| `review` | `contents: read`, `pull-requests: write` |
| `refactor` | `contents: read`, `issues: write` |
| `both` | `contents: read`, `pull-requests: write`, `issues: write` |

If your repository or organization sets the default workflow token to read-only, the
`permissions:` block above is required, not optional.

## Choosing a provider

Anthropic is the default:

```yaml
with:
  provider: anthropic          # default
  model: claude-opus-5         # default
  api-key: ${{ secrets.ANTHROPIC_API_KEY }}
```

Anything speaking the OpenAI chat-completions protocol works through `base-url`:

```yaml
with:
  provider: openai
  base-url: https://openrouter.ai/api/v1
  model: qwen/qwen3-coder
  api-key: ${{ secrets.OPENROUTER_API_KEY }}
```

Self-hosted endpoints vary in what they support. Hawky starts with strict JSON-schema
structured output and steps down to JSON mode, then to a prompted JSON instruction,
based on what the server rejects. You do not have to declare your endpoint's
capabilities; it works them out on the first call and remembers them for the run.

Enforcement quality varies too, so the response is checked against the schema on the
client rather than assumed to have been enforced. An endpoint that accepts a schema and
then answers with something that does not match it steps down the same way a rejection
does, and the log names the offending field.

### Reasoning models

A reasoning model thinks before it answers, and both halves come out of the same output
budget. Hawky asks for one JSON object per batch and caps the reply at
`max-response-tokens` (16,000 by default), so a model that spends 15,000 tokens
deliberating has nothing left to answer with — the JSON is cut off mid-object and the
batch fails. **Shrinking `max_chars_per_batch` does not help**: the thinking scales with
the question, not with the size of the answer, so one small file gets the same long
deliberation as ten.

Turn it off:

```yaml
with:
  provider: openai
  base-url: https://api.fireworks.ai/inference/v1
  model: accounts/fireworks/models/glm-5p2
  api-key: ${{ secrets.FIREWORKS_API_KEY }}
  reasoning: none
```

That sends `reasoning_effort: none`. Endpoints that do not implement the parameter
answer 4xx; hawky logs that and retries without it, so nothing breaks, but the model
keeps thinking. Those servers usually expose the switch through the chat template
instead, which `request_options` passes through verbatim:

```yaml
# .github/hawky.yml
request_options:
  chat_template_kwargs:
    thinking: false
```

Check your provider's docs for the exact key — `request_options` is merged into the
request body as-is, and it overrides anything hawky set itself.

If you would rather let the model think and pay for it, raise the ceiling instead:
`max-response-tokens: 48000`.

### Truncated replies fix themselves

`max_response_tokens` is a guillotine, not a target: the model emits its thinking first
and the answer after it, and when the counter runs out generation stops mid-token — no
closing brace, nothing parseable. Rather than failing the batch, hawky treats that as a
budget problem and works its way out of it:

1. **Stop the thinking**, if that is where the budget went — one retry with
   `reasoning_effort: none`. Cheapest fix, and usually the only one needed.
2. **Buy more room.** The budget doubles and the call is retried, up to three times
   (16k → 32k → 64k → 128k by default). You are billed for tokens generated, not for the
   ceiling you ask for, so a raise costs nothing on batches that already fit.
3. **Back off the model's own limit.** If the endpoint refuses a budget that large, hawky
   falls back to the biggest value it will take instead of failing on a 400.

A raise earned by one batch carries to the rest of the run, so a large pull request does
not rediscover the same ceiling once per file. Only when every rung is spent does the
batch fail, and the message then names the wall it hit — your configured budget or the
model's hard ceiling — rather than guessing at batch size.

### Reasoning never reaches a comment

Chain of thought is stripped out of the reply before the JSON is parsed, whether it
arrives in a `reasoning_content` field (Fireworks, Together, DeepSeek, vLLM) or inline in
`<think>` tags, and an unclosed tag drops everything after it rather than letting the
parser latch onto braces inside the deliberation. Stripping runs only as a repair, after
the raw body fails to parse, so a review that legitimately quotes `<think>` in its own
text survives untouched. The prompt also tells the model that every field holds a
finished answer and not its working-out — the one path stripping cannot reach is
deliberation written *into* a finding's body.

## Modes

`mode` decides what the action does; **you** decide when it runs, from your workflow's
`on:` block.

| `mode` | Does |
| --- | --- |
| `review` (default) | Inline comments plus a summary comment on the pull request |
| `refactor` | Opens refactoring issues; posts nothing on the PR |
| `both` | Both, in one run |

Refactoring issues on every pull request will bury your issue tracker. The pairing most
teams want is `review` on `pull_request` and `refactor` on `push` to the default branch:

```yaml
# .github/workflows/review.yml
on: { pull_request: }
permissions: { contents: read, pull-requests: write }
# ... mode defaults to review

# .github/workflows/refactor.yml
on: { push: { branches: [main] } }
permissions: { contents: read, issues: write }
# ... with: { mode: refactor }
```

See [`examples/`](examples/) for both, plus an OpenAI-compatible setup and the fork-safe
pattern below.

## Pull requests from forks

A `pull_request` run triggered by a fork gets a **read-only token and no secrets**. It
cannot call the LLM and it cannot post comments. This is a GitHub security boundary, not
a limitation of this action.

The commonly suggested fix — `pull_request_target` — runs with a write token *and* your
secrets while the fork's code is checked out. A pull request that edits a build script or
a test helper can then read your API key. Do not do it.

The safe pattern is two workflows: one triggered by `pull_request` that records the PR
number and never sees a secret, and one triggered by `workflow_run` that has the secrets
but never checks out fork code. Pass the number through `HAWKY_PR_NUMBER`. A working pair
is in [`examples/fork-safe.yml`](examples/fork-safe.yml).

## Configuration

Every input is optional except `api-key`.

| Input | Default | Description |
| --- | --- | --- |
| `api-key` | — | **Required.** API key for the provider. |
| `provider` | `anthropic` | `anthropic` or `openai`. |
| `model` | `claude-opus-5` / `gpt-4.1` | Model id. |
| `base-url` | — | Override the API base URL. |
| `reasoning` | endpoint default | `none`, `minimal`, `low`, `medium`, or `high`. See [Reasoning models](#reasoning-models). |
| `max-response-tokens` | `16000` | Starting output budget per call, reasoning included. Raised automatically when a reply is cut off. |
| `mode` | `review` | `review`, `refactor`, or `both`. |
| `github-token` | `${{ github.token }}` | Token used to read the diff and write comments and issues. |
| `config-path` | `.github/hawky.yml` | YAML config file. |
| `max-comments` | `15` | Cap on inline comments per run. |
| `min-severity` | `medium` | Drop findings below this severity. |
| `min-confidence` | `0.6` | Drop findings the model is unsure about. |
| `include` | — | Globs to restrict review to. |
| `exclude` | — | Globs to skip, added to the built-in list. |
| `guidelines` | — | Project conventions injected into the prompt. |
| `fail-on-severity` | `none` | Fail the check at or above this severity. |
| `fail-on-incomplete` | `false` | Fail the check if part of the diff could not be reviewed. |
| `dismissals` | `all` | How a reviewer waives a false positive: `all`, `command`, or `off`. See [Waiving a false positive](#waiving-a-false-positive). |
| `ponytail` | `full` | How hard to review for over-engineering: `full`, `lite`, `ultra`, or `off`. See [Reviewing for over-engineering](#reviewing-for-over-engineering). |
| `bug-report-footer` | `true` | End the summary comment with a collapsed section on reporting a bug in Hawky. See [Reporting Hawky bugs](#reporting-hawky-bugs). |
| `max-issues` | `3` | Cap on refactoring issues per run. |
| `issue-labels` | `hawky,refactor` | Labels applied to refactoring issues. |
| `dry-run` | `false` | Log what would be posted without posting it. |

Outputs: `review-passed`, `highest-severity`, `findings-count`, `dismissed-count`,
`issues-created`, `summary`.

### Blocking pull requests

`fail-on-severity` turns the review into a merge gate: the step fails when any finding at
or above that severity survives filtering, so the job goes red and a required status check
blocks the pull request.

```yaml
jobs:
  review:
    runs-on: ubuntu-latest
    steps:
      - uses: KeunwooPark/hawky@v1
        with:
          api-key: ${{ secrets.ANTHROPIC_API_KEY }}
          fail-on-severity: high
          fail-on-incomplete: true
```

Then make it required: **Settings → Branches → Branch protection rules →
Require status checks to pass**, and select the job (`review` above). Merging is blocked
until a push produces a run with no finding at or above the threshold.

Three details matter if you rely on this:

- The gate looks at every finding that clears `min-severity` and `min-confidence` and
  anchors to a line this pull request changed, including ones an earlier run already
  commented on. Pushing again does not clear a finding the model still reports — fixing
  the code does, or waiving it does when the model is wrong.
- `fail-on-incomplete: true` also fails the check when an LLM call errors out and part of
  the diff went unreviewed. Without it, a partly-reviewed diff can report a pass.
- The step still posts its comments before failing, so authors see what to fix.

**The gate is off until you set `fail-on-severity`.** Without it the default is `none`:
Hawky leaves its High and Critical comments and the check still passes. Every run now says
which it did, in three places — the run log (`Gate: off (fail-on-severity is not set)` or
`Gate: fail-on-severity=high, highest severity found=high -> FAIL`), the job summary, and
the sticky summary comment on the pull request itself. If a High comment sits on a green
check, read that line first.

Two ways to set the threshold and get nothing: a value that is not
`low`/`medium`/`high`/`critical`/`none`, and `fail-on-severity` written in kebab case in
`.github/hawky.yml`, which takes `fail_on_severity`. Both used to fall back to `none` in
silence; both now warn in the run log.

### Waiving a false positive

A gate with no way past it is a deadlock the first time the model is wrong: the gate
re-reads every finding on every push, so pushing more commits does not clear one — only
changing code the reviewer has already decided is correct would, and that is the wrong
fix.

So a maintainer can waive a finding. Reply in its thread:

```
@hawky ignore the caller already validates this, see auth.ts:88
```

Or resolve the review thread, which means the same thing. Either way the next run drops
that finding: it stops gating, and it is not reposted.

A finding can also end up in the summary comment rather than in a thread of its own: when
GitHub rejects the review as a whole, every comment in it falls back there rather than
being lost. Those have no thread to reply in, so the summary prints an id for each one.
Name it in a comment on the pull request:

```
@hawky ignore 4f2c9a1b7e0d3c56 generated file, not hand-edited
```

**The check does not turn green on its own.** A required status check belongs to the head
commit, and a comment does not produce a new one. After waiving, re-run the job:
Actions -> the failed run -> **Re-run failed jobs**. Same number of clicks as an admin
override, and unlike an override it leaves a record.

Three things keep this from being a hole in the gate:

- **Only people who could merge anyway.** The command is honoured from repository owners,
  members, and collaborators. A drive-by comment on a public pull request is logged and
  ignored. Resolving a thread is open to the pull request author too, so that route is
  permission-checked separately — and if the token cannot answer the permission question,
  the resolution does not count and the run says so.
- **It is on the record.** The summary comment lists every waived finding with who waived
  it and why, the verdict line says the check is only green because of them, and the same
  goes to the run log and the job summary. `dismissed-count` is available as an output.
- **It is reversible.** Delete the comment that waived a finding (or unresolve its thread)
  and it gates again on the next run.

Narrow or remove the escape hatch with `dismissals`:

| Value | Waives a finding |
| --- | --- |
| `all` (default) | An `@hawky ignore` reply, or resolving the thread |
| `command` | The reply only — resolving a thread is a weaker signal, and people resolve threads casually |
| `off` | Nothing. The gate is absolute. |

An unrecognised value here falls back to `off`, not to the default: a typo should not open
a route past the gate.

To report the verdict without blocking, leave `fail-on-severity` at `none` and read the
outputs instead. They are written even when the step fails, so pair them with `if: always()`:

```yaml
      - uses: KeunwooPark/hawky@v1
        id: hawky
        with:
          api-key: ${{ secrets.ANTHROPIC_API_KEY }}
      - if: always() && steps.hawky.outputs.review-passed != 'true'
        run: echo "Highest severity: ${{ steps.hawky.outputs.highest-severity }}"
```

### Reviewing for over-engineering

Hawky asks two questions of every added block. The first is whether it is wrong. The
second — *does this need to exist at all?* — follows the
[ponytail](https://github.com/DietrichGebert/ponytail) skill's ladder:

1. Does this need to exist at all? A speculative need is not a need.
2. Is it already in this codebase?
3. Does the standard library do it?
4. Does a native platform feature cover it?
5. Does an already-installed dependency solve it?
6. Can it be one line?
7. Only then: the minimum code that works.

`ponytail` sets how hard it presses:

| Value | The reviewer |
| --- | --- |
| `full` (default) | Enforces the ladder — anything that fails a rung is a finding |
| `lite` | Names the lazier alternative once per file and leaves the choice to the author |
| `ultra` | Argues the added code should not exist, not merely that it could be shorter |
| `off` | Looks for defects only |

```yaml
# .github/hawky.yml
ponytail: lite   # or: ultra, off
```

These arrive as ordinary inline comments, tagged in the title so they are skimmable and
categorised `over-engineering`:

> **Medium · over-engineering** — `stdlib:` hand-rolled 27-line email validator
>
> `zod`'s `z.string().email()` is already a dependency here, and the real validation is
> the confirmation mail. net: -27 lines.

Two things keep the pass from turning into noise:

- **It cannot block a merge.** These findings are capped at `medium` severity, in the
  prompt and again in code before the gate reads them. `fail-on-severity: high` catches
  defects and ignores complexity, which is the split most teams want.
- **It will not ask you to delete the code you need.** Validation at a trust boundary,
  error handling that prevents data loss, security measures, accessibility basics, and
  the one test that fails when the logic breaks are all explicitly out of scope, however
  many lines they cost. So is anything the pull request description asks for by name.

Over-engineering findings are waived like any other, with `@hawky ignore` — worth knowing
if your team disagrees with one of them more than once.

### Reporting Hawky bugs

The summary comment ends with a collapsed section, **Is Hawky itself broken? Report it**.
It links to a bug report on this repository with the version, model, and settings filled
in. Coding agents read these comments too, so it also spells out how an agent should file
one:

- tell its user what it saw and ask before filing, and look for an existing report first;
- quote the Hawky version, provider and model, and settings, which the section prints;
- leave the pull request out of it: no code, diffs, file paths, comment text, or
  repository names. This tracker is public, and your repository may not be.

The section is written in the open rather than hidden in an HTML comment. A well-behaved
agent treats instructions it finds in a pull request as data, not as its user's wishes, and
it should not act on anything it cannot show you — so the section asks the agent to check
with you instead of telling it to file.

To let your agents file without asking each time, say so where they take instructions from
you — `AGENTS.md`, `CLAUDE.md`, or your agent's equivalent:

```markdown
## Hawky
When a Hawky review is itself broken (a comment on the wrong line, garbled text, a verdict
that contradicts the findings), you may file a bug on KeunwooPark/hawky without asking
first, following the "Is Hawky itself broken?" section of its summary comment. Never
include code, file paths, or names from this repository.
```

Turn the section off with `bug-report-footer: false`.

### Config file

Anything in the table can live in `.github/hawky.yml` instead, in snake_case. Action
inputs win over the file, and the file wins over the defaults. This is the better place
for `guidelines`, which are usually long:

```yaml
model: claude-opus-5
min_severity: high
max_comments: 10

exclude:
  - "docs/**"
  - "**/*.pb.go"

# Set to false to review lockfiles, dist/, minified output, and so on.
exclude_defaults: true

# How a reviewer waives a false positive so it stops blocking the merge:
# "all" (an `@hawky ignore` reply, or resolving the thread), "command" (the
# reply only), or "off" (nothing waives a finding).
dismissals: all

# How hard to hunt over-engineering: "full" (default), "lite", "ultra", or "off".
# These findings are capped at medium severity so they cannot fail a merge gate.
ponytail: full

# End the summary comment with a collapsed "Is Hawky itself broken?" section.
bug_report_footer: true

# Extra fields merged into the request body, for endpoint-specific knobs.
# Passed through verbatim, so a typo here reaches the server.
request_options: {}

guidelines: |
  Every database write goes through the repository layer; flag direct SQL in handlers.
  Public API changes need a changeset entry.
  We target Node 20, so no syntax newer than ES2023.
```

## Keeping the signal high

The defaults are tuned so a reviewer reads the comments rather than muting the bot.

- **Severity and confidence floors.** The model reports both, and anything below the
  threshold is discarded before posting. Guesses are meant to be dropped.
- **A hard cap on comments.** The highest-severity findings survive the cap.
- **No style opinions.** The prompt explicitly excludes formatting, naming, and comment
  density — your linter already covers those, and the model is worse at them.
- **Complexity does not block merges.** An over-engineering finding is capped at
  `medium` severity, so the ponytail pass runs while `fail-on-severity` still means
  "there is a bug in this".
- **No repeats.** Every comment carries a fingerprint derived from the path, category,
  and title, but not the line number, so a finding that scrolls down when you edit the
  file above it is still recognised as the same finding on the next push.
- **Closed issues stay closed.** A refactoring issue you close is a decision; it is never
  reopened or refiled.
- **A waived finding stays waived.** `@hawky ignore` in a thread is a decision too; the
  finding stops gating and is not reposted. See
  [Waiving a false positive](#waiving-a-false-positive).

If the reviews are still too chatty, raise `min_severity` to `high` before lowering
`max_comments` — you want fewer *kinds* of comment, not a truncated list.

## Cost

One LLM call per batch of files, plus nothing else. On Anthropic, the system prompt
carries a cache breakpoint, so a pull request large enough to need several batches pays
full price for the prompt once and cache rates after that.

Large pull requests are split into batches of roughly 120,000 characters (about 34k
tokens); `max_files` and `max_chars_per_batch` in the config file bound the worst case.
On the output side, `max_response_tokens` is the starting budget per reply, doubling on a
truncated answer up to three times. Only generated tokens are billed, so the ceiling
itself is free; on a reasoning model, though, the thinking is generated and billed too,
and is usually the larger half.
Lockfiles, generated code, minified bundles, and binaries are excluded before anything is
sent.

## How it works

1. Fetch the changed files from the GitHub API — no checkout, no `git` shelling out.
2. Filter out excluded, binary, and deleted files, and name the ones that were withheld in
   the prompt. A definition the model cannot see is the usual reason a review calls a
   symbol undefined, so it is told which files changed without being shown.
3. Re-render each hunk with head-revision line numbers in the gutter, so the model
   anchors to real, addressable lines.
4. Pack files into batches and send each with a JSON schema the response must satisfy,
   then check the response against that schema before using it.
5. Validate every anchor against the lines actually present in the diff, and discard any
   finding pointing outside it. A line that is not in the diff means the model misread its
   partial view and invented the location, so the finding is neither posted nor gated on,
   and the run log names it. This also keeps GitHub from rejecting the entire review with
   a 422, which one bad anchor is enough to cause.
6. Post one review with all inline comments, and update the sticky summary in place.
7. File refactoring issues, skipping anything already tracked.

## Development

```bash
npm ci
npm run typecheck
npm test
npm run build      # bundles src/ into dist/index.js — commit the result
```

`dist/` is what the action executes, so it is committed and CI fails if it is out of date.

### Releasing

Bump `version` in `package.json` first. It is bundled into `dist/`, and it is the version
the summary comment prints and bug reports quote.

```bash
npm run build && git add dist && git commit -m "Build" && git push
git tag v1.0.0 && git push origin v1.0.0
gh release create v1.0.0 --generate-notes
```

Publishing the release triggers `.github/workflows/release.yml`, which re-runs the tests,
rebuilds the bundle to confirm `dist/` at that tag matches `src/`, and then force-moves
the `v1` tag onto the release commit. Consumers pinned to `@v1` pick it up on their next
run with no change on their side.

Breaking changes go to `v2.0.0`, which creates a new `v2` alias and leaves everyone on
`@v1` where they are.

To list on the GitHub Marketplace, tick "Publish this Action to the GitHub Marketplace"
when drafting the release in the web UI. That is a one-time manual step; the `name`,
`description`, and `branding` fields in `action.yml` are what it validates against.

## Troubleshooting

**The workflow ran but nothing was posted.** Most often the pull request came from a fork,
where the token is read-only and secrets are unavailable — see the fork section above. Also
check `permissions:` against the table in Quick start.

**"Resource not accessible by integration".** The job is missing `pull-requests: write` or
`issues: write`, or the repository default token is read-only.

**Comments appear in the summary instead of inline.** GitHub rejected the review as a
whole, so every comment in it fell back to the summary rather than being lost. The run log
names the underlying error.

**Hawky commented on a variable or function that does not exist.** It sees only the changed
hunks, and the line numbers jump over everything between them, so a definition a few lines
away can be invisible to it. Three things work against that: the prompt says a gap in the
numbering is unseen code rather than absent code, it lists the files that changed without
being shown, and any finding anchored to a line outside the diff is discarded and named in
the run log. If it still happens often, the model is likely too small for the job — and it
is worth reporting, because a review should not discuss code it was never shown.

**"never finished the JSON answer within N output tokens".** Every rung of the retry
ladder was spent: thinking off, budget doubled three times, and the reply was still cut
off. The message names which wall it hit. If it went on reasoning, lowering
`max_chars_per_batch` will not fix it — set `reasoning: none`, or use `request_options`
if your endpoint ignores `reasoning_effort`. See [Reasoning models](#reasoning-models).

**A finding trails off mid-sentence, or the summary asks you to paste the code.** The
model's chain of thought reached the reply instead of its answer. Hawky strips `<think>`
blocks and `reasoning_content` before parsing, so an older version is the likely cause;
`reasoning: none` removes it at the source.

**The same comments keep reappearing on every push.** Fingerprints live in a hidden HTML
comment on each posted comment. Deleting or editing those comments loses the record.

**Nothing happens on draft pull requests.** By design in the example workflow — remove the
`if: github.event.pull_request.draft == false` guard if you want them reviewed.

**Want to see what it would do without posting?** Set `dry-run: true`. It logs the full
review, including every inline comment, and writes nothing.

## License

MIT
