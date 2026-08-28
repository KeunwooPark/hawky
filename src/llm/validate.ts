/**
 * A small validator for the subset of JSON Schema this action actually sends.
 *
 * The endpoint is asked to enforce the schema, but "OpenAI-compatible" servers
 * differ in whether they honour strict mode, forward it to the backend, or
 * quietly ignore it — and a response that omits a required field is accepted,
 * parsed, and only fails much later, far from its cause. So the client checks
 * the response itself rather than trusting the server did.
 *
 * Covers `type` (including nullable unions), `required`, `properties`, `items`
 * and `enum`. `additionalProperties` is deliberately not enforced: unexpected
 * keys are ignored downstream and harmless, and rejecting them would fail runs
 * over a model quirk that costs nothing.
 */

type Schema = Record<string, unknown>;

/** Thrown when a parsed response does not match the schema the request declared. */
export class SchemaViolationError extends Error {
  constructor(readonly violations: string[]) {
    super(`Response did not match the requested schema: ${violations.join('; ')}`);
    this.name = 'SchemaViolationError';
  }
}

function typeOf(value: unknown): string {
  if (value === null) return 'null';
  if (Array.isArray(value)) return 'array';
  if (Number.isInteger(value)) return 'integer';
  return typeof value;
}

function matchesType(value: unknown, type: string): boolean {
  const actual = typeOf(value);
  if (type === 'number') return actual === 'number' || actual === 'integer';
  return actual === type;
}

function check(value: unknown, schema: Schema, path: string, out: string[]): void {
  const declared = schema.type;
  if (typeof declared === 'string' || Array.isArray(declared)) {
    const types = (Array.isArray(declared) ? declared : [declared]) as string[];
    if (!types.some((t) => matchesType(value, t))) {
      out.push(`${path} should be ${types.join(' or ')}, got ${typeOf(value)}`);
      return; // Nothing below can be meaningful once the type is wrong.
    }
  }

  const values = schema.enum;
  if (Array.isArray(values) && !values.includes(value as never)) {
    out.push(`${path} should be one of ${values.join(', ')}, got ${JSON.stringify(value)}`);
  }

  if (typeOf(value) === 'object') {
    const object = value as Record<string, unknown>;
    const properties = (schema.properties ?? {}) as Record<string, Schema>;
    for (const key of (schema.required ?? []) as string[]) {
      if (!(key in object)) out.push(`${path}.${key} is missing`);
    }
    for (const [key, sub] of Object.entries(properties)) {
      if (key in object) check(object[key], sub, `${path}.${key}`, out);
    }
  } else if (Array.isArray(value) && schema.items) {
    value.forEach((item, i) => check(item, schema.items as Schema, `${path}[${i}]`, out));
  }
}

/** Returns every way `data` violates `schema`, most-specific first, or an empty list. */
export function schemaViolations(data: unknown, schema: Schema): string[] {
  const out: string[] = [];
  check(data, schema, 'response', out);
  return out;
}

/** Throws `SchemaViolationError` when `data` does not conform to `schema`. */
export function assertMatchesSchema(data: unknown, schema: Schema): void {
  const violations = schemaViolations(data, schema);
  if (violations.length) throw new SchemaViolationError(violations);
}
