import assert from 'node:assert/strict';
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import { afterEach, test } from 'node:test';
import { loadConfig } from '../src/config.js';
import { captureWarningsSync } from './warnings.js';

/**
 * `loadConfig` reads action inputs from the environment and warns on stdout, so
 * both sides are driven through those rather than through injected fakes.
 */
function withInputs(inputs: Record<string, string>, fileBody?: string) {
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
    const { result: cfg, warnings } = captureWarningsSync(loadConfig);
    return { cfg, warnings };
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

test('the over-engineering pass is on by default', () => {
  const { cfg, warnings } = withInputs({});
  assert.equal(cfg.ponytail, 'full');
  assert.deepEqual(warnings, []);
});

test('ponytail: off is the way back to a defects-only review', () => {
  assert.equal(withInputs({ ponytail: 'off' }).cfg.ponytail, 'off');
  assert.equal(withInputs({}, 'ponytail: off\n').cfg.ponytail, 'off');
});

test('a ponytail level is read from the config file', () => {
  const { cfg, warnings } = withInputs({}, 'ponytail: ultra\n');
  assert.equal(cfg.ponytail, 'ultra');
  assert.deepEqual(warnings, []);
});

test('ponytail written as a flag turns the pass on at full', () => {
  // YAML would have parsed a bare `true` into a boolean; both spellings mean on.
  assert.equal(withInputs({ ponytail: 'true' }).cfg.ponytail, 'full');
  assert.equal(withInputs({}, 'ponytail: true\n').cfg.ponytail, 'full');
  assert.equal(withInputs({}, 'ponytail: false\n').cfg.ponytail, 'off');
});

test('a misspelled ponytail level warns instead of silently switching the pass off', () => {
  const { cfg, warnings } = withInputs({ ponytail: 'extra' });

  // Reading a typo as "off" would grant a request nobody made, and quietly.
  assert.equal(cfg.ponytail, 'full');
  assert.equal(warnings.length, 1);
  assert.match(warnings[0], /Unknown ponytail level "extra"/);
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

test('an unknown dismissals mode shuts the route off rather than opening it', () => {
  // The opposite fallback to every other setting, and deliberately so: a typo
  // that quietly opens a way past the merge gate is worse than one that leaves
  // the gate shut and says why.
  const { cfg, warnings } = withInputs({ dismissals: 'comand' });
  assert.equal(cfg.dismissals, 'off');
  assert.match(warnings.join('\n'), /Unknown dismissals mode "comand"/);
});
