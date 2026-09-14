/**
 * Pull a JSON object out of a model response.
 *
 * With structured outputs the whole body is already JSON, but two things get in
 * the way. OpenAI-compatible servers that do not implement `response_format`
 * fall back to plain text, which may arrive wrapped in a code fence or trailed
 * by a sentence of commentary. And reasoning models often emit their chain of
 * thought in the same `content` field, either fenced in `<think>` tags or as a
 * bare preamble, which is prose that happens to contain braces.
 */

/** Tags reasoning models wrap their chain of thought in, in the content field. */
const REASONING_TAGS = ['think', 'thinking', 'reason', 'reasoning', 'thought'];

const CLOSED_REASONING = new RegExp(`<(${REASONING_TAGS.join('|')})\\b[^>]*>[\\s\\S]*?<\\/\\1\\s*>`, 'gi');
const UNCLOSED_REASONING = new RegExp(`<(${REASONING_TAGS.join('|')})\\b[^>]*>[\\s\\S]*$`, 'i');

/**
 * Remove a reasoning model's chain of thought from a response body.
 *
 * An unclosed opening tag means the reply was cut off mid-thought, so everything
 * after it is dropped too: there is no answer behind it to recover, and leaving
 * it in gives the parser braces to latch onto.
 */
export function stripReasoning(text: string): string {
  return text.replace(CLOSED_REASONING, '').replace(UNCLOSED_REASONING, '').trim();
}

/** True when the body carried a chain of thought, closed or truncated. */
export function containsReasoning(text: string): boolean {
  return new RegExp(`<(${REASONING_TAGS.join('|')})\\b[^>]*>`, 'i').test(text);
}

/**
 * Yield every balanced `{...}` span in the text, outermost first.
 *
 * `indexOf('{')` to `lastIndexOf('}')` is not good enough: a reply padded with
 * prose can open a brace inside the padding and close one after the JSON, and
 * the resulting slice parses as nothing at all. Tracking depth and string
 * literals finds the spans that could actually be objects.
 */
function* balancedObjects(text: string, maxCandidates = 50): Generator<string> {
  let found = 0;
  for (let i = 0; i < text.length && found < maxCandidates; i++) {
    if (text[i] !== '{') continue;
    let depth = 0;
    let inString = false;
    let escaped = false;
    for (let j = i; j < text.length; j++) {
      const c = text[j];
      if (escaped) {
        escaped = false;
      } else if (c === '\\') {
        escaped = inString;
      } else if (c === '"') {
        inString = !inString;
      } else if (!inString && c === '{') {
        depth++;
      } else if (!inString && c === '}' && --depth === 0) {
        found++;
        yield text.slice(i, j + 1);
        break;
      }
    }
  }
}

function tryParseObject<T>(candidate: string): T | undefined {
  try {
    const parsed: unknown = JSON.parse(candidate);
    if (parsed && typeof parsed === 'object' && !Array.isArray(parsed)) return parsed as T;
  } catch {
    // Not JSON; the caller moves on to the next candidate.
  }
  return undefined;
}

export function parseJsonObject<T>(text: string): T {
  // Try the body as it stands before repairing it. Stripping reasoning is a
  // repair, and a valid response that merely quotes a `<think>` tag inside one
  // of its own strings does not need repairing — it needs leaving alone.
  const direct = tryParseObject<T>(text.trim());
  if (direct !== undefined) return direct;

  const hadReasoning = containsReasoning(text);
  const trimmed = stripReasoning(text);

  const fenced = /```(?:json)?\s*([\s\S]*?)```/.exec(trimmed);
  if (fenced) {
    const parsed = tryParseObject<T>(fenced[1].trim());
    if (parsed !== undefined) return parsed;
  }

  for (const candidate of balancedObjects(trimmed)) {
    const parsed = tryParseObject<T>(candidate);
    if (parsed !== undefined) return parsed;
  }

  const why = hadReasoning
    ? ' The reply was mostly the model\'s own reasoning; turn `reasoning` down to the lowest level your ' +
      'endpoint implements (`minimal`, or `low` where there is no `minimal`) or raise `max-response-tokens` ' +
      'so there is budget left for an answer.'
    : '';
  throw new Error(`Model did not return JSON.${why} First 300 characters: ${trimmed.slice(0, 300)}`);
}

/** Appended to the prompt when the endpoint cannot enforce a schema itself. */
export function schemaInstruction(schema: Record<string, unknown>): string {
  return [
    '',
    'Respond with a single JSON object and nothing else — no prose, no code fence, no reasoning.',
    'It must conform to this JSON Schema:',
    '',
    JSON.stringify(schema),
  ].join('\n');
}
