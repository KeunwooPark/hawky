/**
 * One JSON Schema, used by both providers.
 *
 * Written to satisfy OpenAI strict structured outputs, which is the stricter of
 * the two: every object sets `additionalProperties: false`, every property is
 * listed in `required`, and optional fields are expressed as nullable unions
 * rather than being omitted. Numeric range constraints are left out because
 * strict mode does not accept them.
 */
export const REVIEW_SCHEMA: Record<string, unknown> = {
  type: 'object',
  additionalProperties: false,
  required: ['summary', 'findings', 'refactors'],
  properties: {
    summary: {
      type: 'string',
      description:
        'Two to four sentences describing what this change does and the overall state of it. No bullet lists.',
    },
    findings: {
      type: 'array',
      description: 'Problems anchored to a specific changed line. Empty when the change is clean.',
      items: {
        type: 'object',
        additionalProperties: false,
        required: ['path', 'line', 'end_line', 'severity', 'confidence', 'category', 'title', 'body', 'suggestion'],
        properties: {
          path: { type: 'string', description: 'Repository-relative path, exactly as given in the diff.' },
          line: {
            type: 'integer',
            description: 'Head-revision line number shown in the left gutter of the diff. Must be an added (+) line.',
          },
          end_line: {
            type: ['integer', 'null'],
            description: 'Last line of a multi-line finding, or null for a single line.',
          },
          severity: {
            type: 'string',
            enum: ['low', 'medium', 'high', 'critical'],
            description:
              'critical: data loss, security hole, or guaranteed breakage. high: a bug that will fire in normal use. medium: a real defect in an edge case, or a change that will cause maintenance pain. low: minor.',
          },
          confidence: {
            type: 'number',
            description: 'Between 0 and 1. How sure you are this is a genuine defect and not a misreading of partial context.',
          },
          category: {
            type: 'string',
            enum: [
              'correctness',
              'security',
              'performance',
              'concurrency',
              'error-handling',
              'api-design',
              'testing',
              'maintainability',
              'over-engineering',
              'documentation',
            ],
          },
          title: { type: 'string', description: 'One short line, under 80 characters. No trailing period.' },
          body: {
            type: 'string',
            description:
              'What is wrong, the concrete input or state that triggers it, and the consequence. Markdown. Two to five sentences.',
          },
          suggestion: {
            type: ['string', 'null'],
            description:
              'Replacement source for lines [line, end_line] with original indentation, or null. Must be complete, valid code, not a fragment or a comment.',
          },
        },
      },
    },
    refactors: {
      type: 'array',
      description:
        'Structural improvements too large for an inline comment. Empty unless the change genuinely exposes one.',
      items: {
        type: 'object',
        additionalProperties: false,
        required: ['title', 'rationale', 'files', 'effort', 'body'],
        properties: {
          title: { type: 'string', description: 'Imperative and specific, e.g. "Extract retry logic out of ApiClient".' },
          rationale: { type: 'string', description: 'One sentence on why this is worth doing now.' },
          files: { type: 'array', items: { type: 'string' }, description: 'Paths the work would touch.' },
          effort: { type: 'string', enum: ['S', 'M', 'L'] },
          body: {
            type: 'string',
            description:
              'Markdown issue body: the current shape, the problem it causes, and a concrete proposed approach with steps.',
          },
        },
      },
    },
  },
};
