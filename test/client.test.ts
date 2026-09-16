import assert from 'node:assert/strict';
import { test } from 'node:test';
import { fetchConfigFile } from '../src/gh/client.js';
import { captureWarnings } from './warnings.js';

const CONFIG = 'exclude:\n  - "docs/**"\n';

/** What the contents endpoint returns for a file it can render. */
const asFile = (text: string) => ({
  type: 'file',
  encoding: 'base64',
  content: Buffer.from(text, 'utf8').toString('base64'),
});

const returning = (data: unknown) =>
  ({ rest: { repos: { getContent: async () => ({ data }) } } }) as never;

const failing = (status: number) =>
  ({
    rest: {
      repos: {
        getContent: async () => {
          throw Object.assign(new Error(`HTTP ${status}`), { status });
        },
      },
    },
  }) as never;

const fetchFrom = (octokit: never) => fetchConfigFile(octokit, 'o', 'r', '.github/hawky.yml', 'headsha');

test('the config file is read out of the repository and decoded', async () => {
  // The whole point of the fetch: reviewing a diff needs no checkout, so the file
  // that configures the review usually is not on disk to be read.
  assert.equal(await fetchFrom(returning(asFile(CONFIG))), CONFIG);
});

test('a repository with no config file costs nothing and says nothing', async () => {
  // The ordinary case for a repository configured entirely from its workflow.
  const { result, warnings } = await captureWarnings(() => fetchFrom(failing(404)));

  assert.equal(result, undefined);
  assert.deepEqual(warnings, []);
});

test('a read the token cannot make is reported, not fatal', async () => {
  const { result, warnings } = await captureWarnings(() => fetchFrom(failing(403)));

  assert.equal(result, undefined);
  assert.equal(warnings.length, 1);
  assert.match(warnings[0], /action inputs and defaults only/);
});

test('a directory where the config file should be is reported', async () => {
  const { result, warnings } = await captureWarnings(() => fetchFrom(returning([asFile(CONFIG)])));

  assert.equal(result, undefined);
  assert.match(warnings[0], /is not a file/);
});

test('a config file too large for the API to render is reported', async () => {
  const { result, warnings } = await captureWarnings(() =>
    fetchFrom(returning({ type: 'file', encoding: 'none', content: '' })),
  );

  assert.equal(result, undefined);
  assert.match(warnings[0], /too large/);
});
