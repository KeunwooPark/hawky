import assert from 'node:assert/strict';
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import { afterEach, test } from 'node:test';
import { loadConfig, workspaceConfigExists } from '../src/config.js';
import { captureWarningsSync } from './warnings.js';

/**
 * `loadConfig` reads action inputs from the environment and warns on stdout, so
 * both sides are driven through those rather than through injected fakes.
 */
function withInputs(inputs: Record<string, string>, fileBody?: string, fetched?: string) {
  const saved = { ...process.env };
  const workspace = fs.mkdtempSync(path.join(os.tmpdir(), 'hawky-cfg-'));

  for (const key of Object.keys(process.env)) {
    if (key.startsWith('INPUT_')) delete process.env[key];
  }
  process.env.GITHUB_WORKSPACE = workspace;
  process.env['INPUT_API-KEY'] = 'k';
  process.env['INPUT_GITHUB-TOKEN'] = 't';
  for (const [name, value] of Object.entries(inputs)) {
    process.env[`INPUT_${name.toUpperCase()}`] = value;
  }
  if (fileBody !== undefined) {
    fs.mkdirSync(path.join(workspace, '.github'), { recursive: true });
    fs.writeFileSync(path.join(workspace, '.github/hawky.yml'), fileBody);
  }

  try {
    const { result, warnings } = captureWarningsSync(() => ({
      cfg: loadConfig(fetched),
      // Read inside the scaffolding, because it is what decides whether the run
      // goes to the API for the file at all.
      onDisk: workspaceConfigExists(),
    }));
    return { cfg: result.cfg, onDisk: result.onDisk, warnings };
  } finally {
    process.env = saved;
    fs.rmSync(workspace, { recursive: true, force: true });
  }
}

afterEach(() => {
  delete process.env.GITHUB_WORKSPACE;
});

test('an unset fail-on-severity leaves the gate off without complaining', () => {
  const { cfg, warnings } = withInputs({});
  assert.equal(cfg.failOnSeverity, 'none');
  assert.deepEqual(warnings, []);
});

test('a misspelled fail-on-severity warns instead of silently disabling the gate', () => {
  const { cfg, warnings } = withInputs({ 'fail-on-severity': 'higb' });

  // Silently falling back to "none" is what let a critical finding go green.
  assert.equal(cfg.failOnSeverity, 'none');
  assert.equal(warnings.length, 1);
  assert.match(warnings[0], /Unknown fail-on-severity "higb"/);
  assert.match(warnings[0], /will not gate/);
});

test('reasoning: none is still honoured, but says what it costs', () => {
  // Kept working because configurations already set it, warned about because a
  // review that ends in seconds having found nothing reads, to the gate, exactly
  // like a clean diff.
  const { cfg, warnings } = withInputs({ reasoning: 'none' });

  assert.equal(cfg.reasoning, 'none');
  assert.equal(warnings.length, 1);
  assert.match(warnings[0], /turns the model's thinking off entirely/);
  assert.match(warnings[0], /"minimal" as the floor/);
});

test('the spellings people reach for instead of none warn the same way', () => {
  const { cfg, warnings } = withInputs({ reasoning: 'off' });

  assert.equal(cfg.reasoning, 'none');
  assert.equal(warnings.length, 1);
  assert.match(warnings[0], /"minimal" as the floor/);
});

test('request-timeout is derived from the budget unless it is set', () => {
  const { cfg, warnings } = withInputs({});
  assert.equal(cfg.requestTimeoutSeconds, 0);
  assert.deepEqual(warnings, []);
});

test('request-timeout is read from the input and from the file', () => {
  assert.equal(withInputs({ 'request-timeout': '900' }).cfg.requestTimeoutSeconds, 900);
  assert.equal(withInputs({}, 'request_timeout: 900\n').cfg.requestTimeoutSeconds, 900);
});

test('a negative request-timeout warns instead of pinning the deadline to nonsense', () => {
  const { cfg, warnings } = withInputs({ 'request-timeout': '-1' });

  assert.equal(cfg.requestTimeoutSeconds, 0);
  assert.equal(warnings.length, 1);
  assert.match(warnings[0], /request-timeout/);
});

test('reasoning: minimal is accepted without complaint', () => {
  const { cfg, warnings } = withInputs({ reasoning: 'minimal' });

  assert.equal(cfg.reasoning, 'minimal');
  assert.deepEqual(warnings, []);
});

test('the reuse scan is on by default and switched off by name', () => {
  // On by default, because the reuse check is the one a diff cannot answer. It
  // costs nothing in a job with no checkout: there is simply nothing to search.
  const { cfg, warnings } = withInputs({});
  assert.equal(cfg.codebaseContext, true);
  assert.deepEqual(warnings, []);

  assert.equal(withInputs({ 'codebase-context': 'false' }).cfg.codebaseContext, false);
  assert.equal(withInputs({}, 'codebase_context: false\n').cfg.codebaseContext, false);
  assert.equal(withInputs({}, 'codebase_context: true\n').cfg.codebaseContext, true);
});

test('a retired ponytail key is reported rather than silently ignored', () => {
  // The input is gone, not deprecated. A repository still setting it should hear
  // about it once from the unknown-key warning and get the review either way.
  const { warnings } = withInputs({}, 'ponytail: full\n');

  assert.equal(warnings.length, 1);
  assert.match(warnings[0], /unknown key "ponytail"/);
});

test('a misspelled min-severity warns instead of silently widening the filter', () => {
  const { cfg, warnings } = withInputs({ 'min-severity': 'hgih' });
  assert.equal(cfg.minSeverity, 'medium');
  assert.match(warnings[0], /Unknown min-severity "hgih"/);
});

test('a kebab-case key in the config file is reported with the name it should have', () => {
  const { cfg, warnings } = withInputs({}, 'fail-on-severity: high\n');

  // The file is snake_case only, so this key was read as nothing at all.
  assert.equal(cfg.failOnSeverity, 'none');
  assert.equal(warnings.length, 1);
  assert.match(warnings[0], /"fail-on-severity" is being ignored/);
  assert.match(warnings[0], /Did you mean "fail_on_severity"/);
});

test('the snake_case key in the config file actually gates', () => {
  const { cfg, warnings } = withInputs({}, 'fail_on_severity: high\n');
  assert.equal(cfg.failOnSeverity, 'high');
  assert.deepEqual(warnings, []);
});

test('an action input still wins over the config file', () => {
  const { cfg } = withInputs({ 'fail-on-severity': 'critical' }, 'fail_on_severity: low\n');
  assert.equal(cfg.failOnSeverity, 'critical');
});

test('an unrecognised config-file key is named rather than ignored', () => {
  const { warnings } = withInputs({}, 'fail_on_sevrity: high\n');
  assert.equal(warnings.length, 1);
  assert.match(warnings[0], /unknown key "fail_on_sevrity"/);
});

test('the bug-report footer is on by default', () => {
  const { cfg, warnings } = withInputs({});
  assert.equal(cfg.bugReportFooter, true);
  assert.deepEqual(warnings, []);
});

test('the bug-report footer can be switched off from the input or the config file', () => {
  assert.equal(withInputs({ 'bug-report-footer': 'false' }).cfg.bugReportFooter, false);
  // YAML parses a bare `false` into a boolean; it must still mean off.
  const { cfg, warnings } = withInputs({}, 'bug_report_footer: false\n');
  assert.equal(cfg.bugReportFooter, false);
  assert.deepEqual(warnings, []);
});

test('dismissals default to every gesture', () => {
  const { cfg, warnings } = withInputs({});
  assert.equal(cfg.dismissals, 'all');
  assert.deepEqual(warnings, []);
});

test('dismissals can be narrowed to the command, or switched off', () => {
  assert.equal(withInputs({ dismissals: 'command' }).cfg.dismissals, 'command');
  assert.equal(withInputs({ dismissals: 'off' }).cfg.dismissals, 'off');
  assert.equal(withInputs({}, 'dismissals: off\n').cfg.dismissals, 'off');
});

test('the checkout is where the config file is looked for first', () => {
  // What decides whether the run fetches the file over the API instead.
  assert.equal(withInputs({}, 'min_severity: high\n').onDisk, true);
  assert.equal(withInputs({}).onDisk, false);
});

test('a config file fetched from the repository configures the run', () => {
  // The reported bug: no `actions/checkout`, which is how the README says to run
  // this, so no file on disk — and every setting in it was dropped without a
  // word, including the exclude glob that should have kept a documentation
  // change out of the review entirely.
  const { cfg, warnings } = withInputs({}, undefined, 'exclude:\n  - "docs/**"\nfail_on_severity: high\n');

  assert.ok(cfg.exclude.includes('docs/**'));
  assert.equal(cfg.failOnSeverity, 'high');
  assert.deepEqual(warnings, []);
});

test('a fetched config file is screened for bad keys like any other', () => {
  const { cfg, warnings } = withInputs({}, undefined, 'fail-on-severity: high\n');

  assert.equal(cfg.failOnSeverity, 'none');
  assert.match(warnings[0], /Did you mean "fail_on_severity"/);
});

test('an action input still wins over a fetched config file', () => {
  const { cfg } = withInputs({ 'fail-on-severity': 'critical' }, undefined, 'fail_on_severity: low\n');
  assert.equal(cfg.failOnSeverity, 'critical');
});

test('unparseable fetched YAML falls back to defaults and says so', () => {
  const { cfg, warnings } = withInputs({}, undefined, 'exclude: [unterminated\n');

  assert.equal(cfg.failOnSeverity, 'none');
  assert.match(warnings[0], /Could not parse .github\/hawky\.yml/);
});

test('an unknown dismissals mode shuts the route off rather than opening it', () => {
  // The opposite fallback to every other setting, and deliberately so: a typo
  // that quietly opens a way past the merge gate is worse than one that leaves
  // the gate shut and says why.
  const { cfg, warnings } = withInputs({ dismissals: 'comand' });
  assert.equal(cfg.dismissals, 'off');
  assert.match(warnings.join('\n'), /Unknown dismissals mode "comand"/);
});
