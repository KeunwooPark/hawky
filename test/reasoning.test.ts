import assert from 'node:assert/strict';
import { test } from 'node:test';
import { containsReasoning, parseJsonObject, stripReasoning } from '../src/llm/json.js';
import { readMessage } from '../src/llm/openai.js';
import { isBudgetOutOfRange, OutputBudget, TruncatedError } from '../src/llm/budget.js';
import { ReasoningLadder } from '../src/llm/reasoning.js';

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
    // It must name the remedy without prescribing `none`, which buys a parseable
    // answer by giving up the thinking the review is made of.
    (err: unknown) =>
      err instanceof Error &&
      /turn `reasoning` down/.test(err.message) &&
      !/reasoning: none/.test(err.message),
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

test('a rejected effort steps to the nearest level rather than off the scale', () => {
  const ladder = new ReasoningLadder('none');
  assert.equal(ladder.effort, 'none');
  // Dropping the parameter is not a neutral fallback: it hands the model its own
  // default, which is the far end of the scale from the floor that was asked for.
  assert.equal(ladder.reject(), 'minimal');
});

test('a refused value is never asked for again', () => {
  // The reported cycle: `none` was rejected, so the parameter was dropped, so the
  // model reasoned by default until it ran out of budget — whose remedy was to
  // ask for `none` again.
  const ladder = new ReasoningLadder('none');
  assert.equal(ladder.reject(), 'minimal');
  assert.equal(ladder.turnDown(), null);
  assert.equal(ladder.effort, 'minimal');
});

test('rejections walk up the scale without repeating one', () => {
  const ladder = new ReasoningLadder('none');
  assert.deepEqual(
    [ladder.reject(), ladder.reject(), ladder.reject(), ladder.reject(), ladder.reject()],
    ['minimal', 'low', 'medium', 'high', null],
  );
});

test('a scale with nothing left to offer drops the parameter', () => {
  const ladder = new ReasoningLadder('high');
  assert.equal(ladder.reject(), null);
  assert.equal(ladder.effort, null);
});

test('turning down from the endpoint default goes to the floor, not past it', () => {
  const ladder = new ReasoningLadder('auto');
  assert.equal(ladder.effort, null);
  assert.equal(ladder.turnDown(), 'minimal');
});

test('turning down eases the thinking rather than switching it off', () => {
  // `none` answers a diff in seconds having found nothing, and a merge gate
  // cannot tell that from a clean diff. A truncated reply is a budget problem;
  // trading it for a review that passes quietly is not a repair.
  assert.equal(new ReasoningLadder('high').turnDown(), 'minimal');
});

test('a ladder standing on its floor has nothing left to turn down to', () => {
  // Which sends the caller on to the budget instead — the remedy that buys an
  // answer without giving up the review that was asked for.
  assert.equal(new ReasoningLadder('minimal').turnDown(), null);
});

test('the floor guards the automatic descent, not a configured none', () => {
  // Arriving at `none` by configuration is the caller's decision, made once and
  // warned about where it is read; arriving by retry is this class making that
  // decision on a diff nobody was looking at.
  assert.equal(new ReasoningLadder('none').effort, 'none');
});

test('the configured effort is left alone until something refuses it', () => {
  const ladder = new ReasoningLadder('medium');
  assert.equal(ladder.effort, 'medium');
  assert.equal(ladder.moved, false);
  ladder.turnDown();
  assert.equal(ladder.moved, true);
});

test('reasoning that ate the budget is told apart from an answer that was simply long', () => {
  // Only a counted split can show this; the other kinds of evidence know the
  // answer never arrived, not what displaced it.
  assert.equal(new TruncatedError(16_000, 15_900, 'counted').reasoningDominated, true);
  assert.equal(new TruncatedError(16_000, 2_000, 'counted').reasoningDominated, false);
  assert.equal(new TruncatedError(16_000, 0, 'returned').reasoningDominated, false);
  assert.equal(new TruncatedError(16_000, 0, 'none').reasoningDominated, false);
});

test('an out-of-range cap is told apart from an unsupported parameter', () => {
  assert.equal(isBudgetOutOfRange('max_tokens: must be at most 8192'), true);
  assert.equal(isBudgetOutOfRange('max_completion_tokens exceeds the maximum for this model'), true);
  assert.equal(isBudgetOutOfRange('unsupported parameter: max_completion_tokens, use max_tokens'), false);
  assert.equal(isBudgetOutOfRange('response_format is not supported'), false);
});
