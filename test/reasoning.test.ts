import assert from 'node:assert/strict';
import { test } from 'node:test';
import { containsReasoning, parseJsonObject, stripReasoning } from '../src/llm/json.js';
import { readMessage } from '../src/llm/openai.js';
import { isBudgetOutOfRange, OutputBudget } from '../src/llm/budget.js';

test('a closed think block is removed and the answer behind it survives', () => {
  const body = '<think>Let me look at Redaction.swift. Hmm, { maybe } this leaks.</think>\n{"summary":"ok"}';
  assert.deepEqual(parseJsonObject(body), { summary: 'ok' });
  assert.equal(stripReasoning(body), '{"summary":"ok"}');
});

test('multiple think blocks are all removed', () => {
  const body = '<think>first</think>{"a":1}<thinking>second</thinking>';
  assert.deepEqual(parseJsonObject(body), { a: 1 });
});

test('a reply cut off mid-thought is reported as missing JSON, not parsed from the reasoning', () => {
  // The exact shape that produced a finding arguing itself to a stop mid-sentence:
  // braces inside the chain of thought, and no answer behind it.
  const body = '<think>The guard clause {here} is wrong because the caller may';
  assert.throws(
    () => parseJsonObject(body),
    (err: unknown) => err instanceof Error && /reasoning: none/.test(err.message),
  );
});

test('JSON is recovered from prose that opens a brace before it and closes one after', () => {
  const body = 'I considered { the redaction path } first.\n{"summary":"real"}\nEnd of review }';
  assert.deepEqual(parseJsonObject(body), { summary: 'real' });
});

test('a brace inside a string literal does not end the object', () => {
  const body = 'here you go: {"summary":"unbalanced } brace","findings":[]}';
  assert.deepEqual(parseJsonObject(body), { summary: 'unbalanced } brace', findings: [] });
});

test('an escaped quote inside a string does not end the string', () => {
  assert.deepEqual(parseJsonObject('x {"summary":"a \\" b"} y'), { summary: 'a " b' });
});

test('a fenced response still parses', () => {
  assert.deepEqual(parseJsonObject('```json\n{"summary":"fenced"}\n```'), { summary: 'fenced' });
});

test('an array response is not accepted as the object', () => {
  assert.throws(() => parseJsonObject('[1, 2, 3]'), /did not return JSON/);
});

test('containsReasoning distinguishes a chain of thought from ordinary content', () => {
  assert.equal(containsReasoning('<think>hm</think>{}'), true);
  assert.equal(containsReasoning('{"summary":"a < b and c > d"}'), false);
});

test('reasoning in a separate field is kept out of the parsed content', () => {
  const msg = { content: '{"summary":"ok"}', reasoning_content: 'I should check the bounds.' };
  const { content, reasoning, hasAnswer } = readMessage(msg);
  assert.deepEqual(parseJsonObject(content), { summary: 'ok' });
  assert.equal(reasoning, 'I should check the bounds.');
  assert.equal(hasAnswer, true);
});

test('a review that quotes a think tag in its own text is left alone', () => {
  const body = '{"summary":"the template emits <think> unescaped","findings":[]}';
  assert.deepEqual(parseJsonObject(body), {
    summary: 'the template emits <think> unescaped',
    findings: [],
  });
});

test('an empty reasoning field is not mistaken for a chain of thought', () => {
  const { reasoning } = readMessage({ content: '{"summary":"ok"}', reasoning_content: '   ' });
  assert.equal(reasoning, '');
});

test('a reply that is only reasoning leaves no answer to parse', () => {
  const { reasoning, hasAnswer } = readMessage({ content: '<think>still deciding</think>' });
  assert.equal(hasAnswer, false);
  assert.ok(reasoning);
});

test('the budget doubles on each raise and stops after three', () => {
  const budget = new OutputBudget(16_000);
  assert.equal(budget.tokens, 16_000);
  assert.equal(budget.raised, false);
  assert.equal(budget.raise(), 32_000);
  assert.equal(budget.raise(), 64_000);
  assert.equal(budget.raise(), 128_000);
  assert.equal(budget.raise(), null);
  assert.equal(budget.tokens, 128_000);
  assert.equal(budget.raised, true);
});

test('a refused budget falls back and is never asked for again', () => {
  const budget = new OutputBudget(16_000);
  budget.raise();
  budget.raise(); // 64k
  assert.equal(budget.lower(), 32_000);
  // 64k was refused, so the next raise would land back on it and is refused too.
  assert.equal(budget.raise(), null);
  assert.equal(budget.tokens, 32_000);
});

test('a starting budget the model will not accept is a config error, not a retry', () => {
  const budget = new OutputBudget(16_000);
  assert.equal(budget.lower(), null);
});

test('an out-of-range cap is told apart from an unsupported parameter', () => {
  assert.equal(isBudgetOutOfRange('max_tokens: must be at most 8192'), true);
  assert.equal(isBudgetOutOfRange('max_completion_tokens exceeds the maximum for this model'), true);
  assert.equal(isBudgetOutOfRange('unsupported parameter: max_completion_tokens, use max_tokens'), false);
  assert.equal(isBudgetOutOfRange('response_format is not supported'), false);
});
