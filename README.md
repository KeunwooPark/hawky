# Hawky

A GitHub Action that reviews pull requests with an LLM and opens refactoring issues.
Works with the Anthropic API and with any OpenAI-compatible endpoint.

- Inline review comments anchored to the exact changed line, with one-click `suggestion` blocks
- A sticky summary comment that is updated in place instead of piling up
- Refactoring opportunities filed as labelled issues, deduplicated across runs
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
      - uses: keunwoo/hawky@v1
        with:
          api-key: ${{ secrets.ANTHROPIC_API_KEY }}
```

That is the whole setup. No checkout step is needed — the diff comes from the API.

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
| `max-issues` | `3` | Cap on refactoring issues per run. |
| `issue-labels` | `hawky,refactor` | Labels applied to refactoring issues. |
| `dry-run` | `false` | Log what would be posted without posting it. |

Outputs: `findings-count`, `issues-created`, `summary`.

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
- **No repeats.** Every comment carries a fingerprint derived from the path, category,
  and title, but not the line number, so a finding that scrolls down when you edit the
  file above it is still recognised as the same finding on the next push.
- **Closed issues stay closed.** A refactoring issue you close is a decision; it is never
  reopened or refiled.

If the reviews are still too chatty, raise `min_severity` to `high` before lowering
`max_comments` — you want fewer *kinds* of comment, not a truncated list.

## Cost

One LLM call per batch of files, plus nothing else. On Anthropic, the system prompt
carries a cache breakpoint, so a pull request large enough to need several batches pays
full price for the prompt once and cache rates after that.

Large pull requests are split into batches of roughly 120,000 characters (about 34k
tokens); `max_files` and `max_chars_per_batch` in the config file bound the worst case.
Lockfiles, generated code, minified bundles, and binaries are excluded before anything is
sent.

## How it works

1. Fetch the changed files from the GitHub API — no checkout, no `git` shelling out.
2. Filter out excluded, binary, and deleted files.
3. Re-render each hunk with head-revision line numbers in the gutter, so the model
   anchors to real, addressable lines.
4. Pack files into batches and send each with a JSON schema the response must satisfy.
5. Validate every anchor against the lines actually present in the diff. GitHub rejects an
   entire review with a 422 if one comment points outside the diff, so findings that
   cannot be anchored are folded into the summary rather than dropped.
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

## License

MIT
