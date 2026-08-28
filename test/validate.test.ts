import assert from 'node:assert/strict';
import { test } from 'node:test';
import { assertMatchesSchema, SchemaViolationError, schemaViolations } from '../src/llm/validate.js';
import { REVIEW_SCHEMA } from '../src/schema.js';

const clean = { summary: 'Looks fine.', findings: [], refactors: [] };

function finding(overrides: Record<string, unknown> = {}) {
  return {
    path: 'src/a.ts',
    line: 12,
    end_line: null,
    severity: 'high',
    confidence: 0.9,
    category: 'correctness',
    title: 'Off-by-one in the loop bound',
    body: 'body',
    suggestion: null,
    ...overrides,
  };
}

test('a conforming response passes', () => {
  assert.deepEqual(schemaViolations(clean, REVIEW_SCHEMA), []);
  assert.deepEqual(schemaViolations({ ...clean, findings: [finding()] }, REVIEW_SCHEMA), []);
});

test('a response missing the required summary is rejected, naming the field', () => {
  const violations = schemaViolations({ findings: [], refactors: [] }, REVIEW_SCHEMA);
  assert.deepEqual(violations, ['response.summary is missing']);
  assert.throws(
    () => assertMatchesSchema({ findings: [], refactors: [] }, REVIEW_SCHEMA),
    (err: unknown) => err instanceof SchemaViolationError && /summary is missing/.test(err.message),
  );
});

test('a field of the wrong type is rejected and reported with its path', () => {
  const violations = schemaViolations({ ...clean, findings: {} }, REVIEW_SCHEMA);
  assert.deepEqual(violations, ['response.findings should be array, got object']);
});

test('violations inside array items carry the index', () => {
  const violations = schemaViolations({ ...clean, findings: [finding({ line: 'twelve' })] }, REVIEW_SCHEMA);
  assert.deepEqual(violations, ['response.findings[0].line should be integer, got string']);
});

test('a severity outside the enum is rejected rather than silently weakening the gate', () => {
  const violations = schemaViolations({ ...clean, findings: [finding({ severity: 'warning' })] }, REVIEW_SCHEMA);
  assert.equal(violations.length, 1);
  assert.match(violations[0], /^response\.findings\[0\]\.severity should be one of low, medium, high, critical/);
});

test('nullable fields accept both null and the value', () => {
  assert.deepEqual(schemaViolations({ ...clean, findings: [finding({ end_line: 14 })] }, REVIEW_SCHEMA), []);
  assert.deepEqual(schemaViolations({ ...clean, findings: [finding({ suggestion: 'x' })] }, REVIEW_SCHEMA), []);
  assert.deepEqual(schemaViolations({ ...clean, findings: [finding({ end_line: '14' })] }, REVIEW_SCHEMA), [
    'response.findings[0].end_line should be integer or null, got string',
  ]);
});

test('an integer satisfies a number-typed field but not the other way round', () => {
  assert.deepEqual(schemaViolations({ ...clean, findings: [finding({ confidence: 1 })] }, REVIEW_SCHEMA), []);
  assert.deepEqual(schemaViolations({ ...clean, findings: [finding({ line: 12.5 })] }, REVIEW_SCHEMA), [
    'response.findings[0].line should be integer, got number',
  ]);
});

test('unexpected extra properties are tolerated', () => {
  assert.deepEqual(schemaViolations({ ...clean, reasoning: 'thinking out loud' }, REVIEW_SCHEMA), []);
});

test('every violation is reported, not just the first', () => {
  const violations = schemaViolations({ summary: 3 }, REVIEW_SCHEMA);
  assert.deepEqual(violations, [
    'response.findings is missing',
    'response.refactors is missing',
    'response.summary should be string, got integer',
  ]);
});
