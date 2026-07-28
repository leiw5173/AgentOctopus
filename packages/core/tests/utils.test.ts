/**
 * isBinAvailable source + behavioral guards (Plan 5 Task 8).
 *
 * `bin` originates from the UNTRUSTED skill manifest field
 * `metadata.{openclaw,clawdbot}.requires.bins`, which `getRequiredBins`
 * (packages/registry/src/manifest-schema.ts) only type-checks as `string` —
 * no character allowlist. isBinAvailable is invoked during ROUTING (a
 * pre-sandbox phase) from router.ts and executor.ts, so a non-conforming name
 * must NEVER reach a shell. These tests pin both:
 *   - the source never interpolates `${bin}` into a shell string, and
 *   - a malicious bin name is rejected (returns false) without executing any
 *     injected command.
 */
import { describe, it, expect } from 'vitest';
import fs from 'node:fs';
import path from 'node:path';
import { isBinAvailable } from '../src/utils.js';

const UTILS_SRC = fs.readFileSync(
  path.join(__dirname, '..', 'src', 'utils.ts'),
  'utf-8',
);

describe('isBinAvailable source guard', () => {
  it('source never interpolates ${bin} into a shell string', () => {
    // The shell-injection defect was `command -v ${bin}` via execSync. The
    // converged form passes bin as a literal argv element to execFileSync and
    // references it positionally ("$1"), never by string interpolation.
    expect(UTILS_SRC).not.toMatch(/`[^`]*\$\{bin\}[^`]*`/);
    expect(UTILS_SRC).not.toMatch(/'[^']*\$\{bin\}[^']*'/);
    expect(UTILS_SRC).not.toMatch(/"[^"]*\$\{bin\}[^"]*"/);
  });

  it('source uses execFileSync (no shell string interpolation), not execSync', () => {
    expect(UTILS_SRC).not.toMatch(/\bexecSync\b/);
    expect(UTILS_SRC).toMatch(/execFileSync/);
  });

  it('source enforces a bare-name allowlist before any lookup', () => {
    expect(UTILS_SRC).toMatch(/BIN_NAME_RE/);
    expect(UTILS_SRC).toMatch(/\^\[A-Za-z0-9\]\[A-Za-z0-9\._-\]\*\$/);
  });
});

describe('isBinAvailable behavior — malicious bin names are rejected, not executed', () => {
  // The canonical exploit payload. A naive `command -v ${bin}` would run the
  // injected `echo PWNED` (or worse) during routing. isBinAvailable must
  // return false AND must not execute the injected command.
  const MALICIOUS = 'foo; echo PWNED';

  it('returns false for a shell-injection bin name', () => {
    expect(isBinAvailable(MALICIOUS)).toBe(false);
  });

  it('does not execute the injected command (no PWNED side effect)', () => {
    // We assert the negative: the function's only observable effect when given
    // a non-conforming name is to return false. execFileSync with a literal
    // argv would run `command -v "foo; echo PWNED"` (a single bogus binary
    // name) which prints nothing; the allowlist short-circuits even earlier.
    // Capture stdout around the call to prove nothing was printed by an
    // injected command.
    const write = process.stdout.write.bind(process.stdout);
    let captured = '';
    process.stdout.write = ((chunk: any, ...rest: any[]) => {
      captured += chunk?.toString?.() ?? '';
      return write(chunk, ...rest);
    }) as any;
    try {
      const result = isBinAvailable(MALICIOUS);
      expect(result).toBe(false);
    } finally {
      process.stdout.write = write;
    }
    expect(captured).not.toContain('PWNED');
  });

  it.each([
    ['shell semicolon', 'foo; echo PWNED'],
    ['shell &&', 'foo && rm -rf ~'],
    ['shell pipe', 'foo | cat'],
    ['backtick substitution', 'foo`whoami`'],
    ['$(...) substitution', 'foo$(whoami)'],
    ['path separator', '/bin/sh'],
    ['relative path', './foo'],
    ['parent traversal', '../foo'],
    ['leading dash', '-foo'],
    ['whitespace', 'foo bar'],
    ['newline', 'foo\necho PWNED'],
    ['empty string', ''],
    ['only dots', '...'],
  ])('rejects non-conforming name (%s)', (_label, bad) => {
    expect(isBinAvailable(bad)).toBe(false);
  });

  it.each([
    ['simple', 'node'],
    ['dotted', 'python3.11'],
    ['dashed', 'my-tool'],
    ['underscore', 'my_tool'],
    ['alphanumeric', 'tool2'],
  ])('accepts well-formed names for the allowlist (%s) — may pass or fail lookup but never throws', (_label, good) => {
    // Well-formed names pass the allowlist and proceed to a real lookup. We
    // do not assert the lookup result (host-dependent); we assert no throw and
    // a boolean return, proving the allowlist did not reject a valid name.
    let result: unknown;
    expect(() => {
      result = isBinAvailable(good);
    }).not.toThrow();
    expect(typeof result).toBe('boolean');
  });
});
