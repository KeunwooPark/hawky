/**
 * `core.warning` writes the workflow command that turns a line into a CI
 * annotation. A test whose fixture is a warning would otherwise decorate every
 * run with its own inputs, so the command is swallowed and collected instead —
 * the warnings are the assertion, not a problem with the run executing them.
 */
function intercept(): { warnings: string[]; restore: () => void } {
  const warnings: string[] = [];
  const write = process.stdout.write.bind(process.stdout);
  process.stdout.write = ((chunk: string | Uint8Array, ...rest: unknown[]) => {
    const text = typeof chunk === 'string' ? chunk : Buffer.from(chunk).toString();
    if (text.startsWith('::warning::')) {
      warnings.push(text.trim());
      return true;
    }
    return write(chunk as never, ...(rest as []));
  }) as typeof process.stdout.write;
  return { warnings, restore: () => void (process.stdout.write = write) };
}

export function captureWarningsSync<T>(fn: () => T): { result: T; warnings: string[] } {
  const { warnings, restore } = intercept();
  try {
    return { result: fn(), warnings };
  } finally {
    restore();
  }
}

export async function captureWarnings<T>(fn: () => Promise<T>): Promise<{ result: T; warnings: string[] }> {
  const { warnings, restore } = intercept();
  try {
    return { result: await fn(), warnings };
  } finally {
    restore();
  }
}
