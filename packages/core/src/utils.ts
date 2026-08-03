import { execFileSync } from 'node:child_process';

/**
 * Strict allowlist for binary names. A binary name must be a bare program name
 * (no path separators, no shell metacharacters, no whitespace). Anything that
 * fails to match is treated as missing rather than interpolated into a shell.
 *
 * `bin` originates from the UNTRUSTED skill manifest field
 * `metadata.{openclaw,clawdbot}.requires.bins`, which is only type-checked as
 * `string` — never executed or shell-interpolated without first passing this
 * gate. A value like `foo; rm -rf ~` is rejected here and returns `false`.
 */
const BIN_NAME_RE = /^[A-Za-z0-9][A-Za-z0-9._-]*$/;

export function isBinAvailable(bin: string): boolean {
  // Defense layer 1: reject anything that is not a bare binary name. This
  // prevents shell metacharacters, path separators, and whitespace from ever
  // reaching the lookup. Non-conforming names are "missing", never executed.
  if (typeof bin !== 'string' || !BIN_NAME_RE.test(bin)) {
    return false;
  }
  try {
    // Defense layer 2: never interpolate `bin` into a shell string. Pass it as
    // a literal argv element via execFileSync, so even a name that slipped
    // through the allowlist cannot break out of the `command -v` argument.
    execFileSync('sh', ['-c', 'command -v "$1"', 'sh', bin], { stdio: 'ignore' });
    return true;
  } catch {
    return false;
  }
}
