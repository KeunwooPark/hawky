/**
 * Pull a JSON object out of a model response.
 *
 * With structured outputs the whole body is already JSON, but OpenAI-compatible
 * servers that do not implement `response_format` fall back to plain text, which
 * may arrive wrapped in a code fence or trailed by a sentence of commentary.
 */
export function parseJsonObject<T>(text: string): T {
  const trimmed = text.trim();
  try {
    return JSON.parse(trimmed) as T;
  } catch {
    // fall through
  }

  const fenced = /```(?:json)?\s*([\s\S]*?)```/.exec(trimmed);
  if (fenced) {
    try {
      return JSON.parse(fenced[1].trim()) as T;
    } catch {
      // fall through
    }
  }

  const start = trimmed.indexOf('{');
  const end = trimmed.lastIndexOf('}');
  if (start !== -1 && end > start) {
    return JSON.parse(trimmed.slice(start, end + 1)) as T;
  }

  throw new Error(`Model did not return JSON. First 300 characters: ${trimmed.slice(0, 300)}`);
}

/** Appended to the prompt when the endpoint cannot enforce a schema itself. */
export function schemaInstruction(schema: Record<string, unknown>): string {
  return [
    '',
    'Respond with a single JSON object and nothing else — no prose, no code fence.',
    'It must conform to this JSON Schema:',
    '',
    JSON.stringify(schema),
  ].join('\n');
}
