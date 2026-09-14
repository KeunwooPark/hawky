import assert from 'node:assert/strict';
import { test } from 'node:test';
import {
  describeMs,
  isTransientStatus,
  requestTimeoutMs,
  retryAfterMs,
  TransientRetries,
} from '../src/llm/timeout.js';

test('the deadline grows with the budget it has to deliver', () => {
  // The bug this exists to stop: a budget large enough to outlast a fixed
  // ten-minute clock, so every attempt timed out on principle.
  const small = requestTimeoutMs(16_000);
  const large = requestTimeoutMs(48_000);
  assert.ok(large > small, `${large} should exceed ${small}`);
  // 48,000 tokens cannot be generated inside the old flat ten minutes.
  assert.ok(large > 10 * 60 * 1000);
});

test('a small budget still gets the old ten-minute floor', () => {
  // Nothing about a modest budget was broken, so nothing about it gets shorter.
  assert.ok(requestTimeoutMs(1_000) >= 10 * 60 * 1000);
  assert.ok(requestTimeoutMs(0) >= 10 * 60 * 1000);
});

test('an enormous budget is capped rather than believed', () => {
  // Past the ceiling the likelier explanation is a stalled connection, and a
  // batch waiting that long has outlived its own usefulness.
  assert.equal(requestTimeoutMs(10_000_000), 40 * 60 * 1000);
});

test('an explicit override beats the derived value in both directions', () => {
  assert.equal(requestTimeoutMs(48_000, 60), 60_000);
  assert.equal(requestTimeoutMs(1_000, 3_600), 3_600_000);
});

test('an unset override falls back to deriving from the budget', () => {
  assert.equal(requestTimeoutMs(48_000, 0), requestTimeoutMs(48_000));
});

test('transient statuses are the ones a repeat can fix', () => {
  for (const status of [408, 409, 429, 500, 503]) {
    assert.equal(isTransientStatus(status), true, `${status} should be retryable`);
  }
  for (const status of [400, 401, 404, 422]) {
    assert.equal(isTransientStatus(status), false, `${status} should not be retryable`);
  }
  // A timeout carries no status at all; it is handled as its own case, not here.
  assert.equal(isTransientStatus(undefined), false);
});

test('retries back off and then run out', () => {
  const retries = new TransientRetries(3);
  const first = retries.next();
  const second = retries.next();
  const third = retries.next();
  assert.ok(first !== null && second !== null && third !== null);
  assert.ok(second > first, 'the second wait should exceed the first');
  assert.ok(third > second, 'the third wait should exceed the second');
  assert.equal(retries.next(), null, 'a fourth retry is not offered');
  assert.equal(retries.attempts, 3);
});

test('a server that names its own delay is obeyed over the backoff curve', () => {
  const retries = new TransientRetries(3);
  // The curve would say one second here; the rate limiter says five.
  assert.equal(retries.next(5_000), 5_000);
});

test('retry-after is read as seconds or as a date, and otherwise ignored', () => {
  assert.equal(retryAfterMs({ 'retry-after': '5' }), 5_000);
  assert.equal(retryAfterMs(new Headers({ 'retry-after': '2' })), 2_000);

  const now = Date.parse('2026-01-01T00:00:00Z');
  const at = new Date(now + 30_000).toUTCString();
  assert.equal(retryAfterMs({ 'retry-after': at }, now), 30_000);

  // A date already past is a zero wait, not a negative one.
  const stale = new Date(now - 30_000).toUTCString();
  assert.equal(retryAfterMs({ 'retry-after': stale }, now), 0);

  assert.equal(retryAfterMs({}), null);
  assert.equal(retryAfterMs(undefined), null);
  assert.equal(retryAfterMs({ 'retry-after': 'soon' }), null);
});

test('durations read the way a job log reads', () => {
  assert.equal(describeMs(45_000), '45s');
  assert.equal(describeMs(10 * 60 * 1000), '10m00s');
  assert.equal(describeMs(750_000), '12m30s');
});
