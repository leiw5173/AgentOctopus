/**
 * Shared helper-exe spawn plumbing for the Windows sandbox TS wrappers.
 *
 * Every wrapper shells out to the trusted octopus-sandbox-helper.exe built
 * by scripts/build-win-helper.mjs. The default exe path resolves to the
 * build script's output location (packages/sandbox/prebuilds/windows-x64);
 * each wrapper also accepts an injectable `exePath` so the fail-closed path
 * (missing/unexecutable binary, non-zero exit) is testable cross-platform.
 *
 * This module is leaf-package production code: Node stdlib only.
 */
import { execFile } from 'node:child_process';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { WindowsSandboxError } from './errors.js';

export interface HelperSpawnOptions {
  /**
   * Override the helper exe path. Defaults to the build script's output:
   * packages/sandbox/prebuilds/windows-x64/octopus-sandbox-helper.exe.
   */
  exePath?: string;
  /**
   * One-shot stdin payload for the helper. When present, it is written to the
   * spawned child's stdin and stdin is then closed. The helper relays its own
   * stdin to the sandboxed child, so this is how `run()`'s ExecSpec.stdin
   * reaches the skill. Omit for wrappers that take no stdin (sid/grant-acl/
   * teardown) and for the persistent spawn() path (a live pipe, not a
   * buffered payload).
   */
  stdin?: string | Uint8Array;
}

const HERE = path.dirname(fileURLToPath(import.meta.url));

export function defaultHelperExePath(): string {
  return path.join(HERE, '..', '..', 'prebuilds', 'windows-x64', 'octopus-sandbox-helper.exe');
}

export interface HelperResult {
  exitCode: number;
  stdout: string;
  stderr: string;
}

/**
 * Spawn the helper with the given argv, capturing stdout/stderr/exitCode.
 *
 * When `opts.stdin` is present it is written to the child's stdin pipe and
 * stdin is closed (the helper relays it to the sandboxed child); otherwise the
 * child's stdin is left at its default (inherited/closed by execFile).
 *
 * Never rejects on a non-zero exit code — that is a *result* the caller
 * inspects. Rejects (as WindowsSandboxError) only when the exe cannot be
 * spawned at all (missing binary, permission, or a non-Windows host where
 * the PE binary cannot execute).
 */
export async function spawnHelper(argv: string[], opts?: HelperSpawnOptions): Promise<HelperResult> {
  const exe = opts?.exePath ?? defaultHelperExePath();
  return new Promise<HelperResult>((resolve, reject) => {
    const child = execFile(exe, argv, { windowsHide: true }, (error, stdout, stderr) => {
      if (error && typeof (error as NodeJS.ErrnoException & { code?: unknown }).code === 'number') {
        // Non-zero exit is a result, not a spawn failure.
        const exitCode = (error as unknown as { code: number }).code;
        resolve({ exitCode, stdout: String(stdout), stderr: String(stderr) });
        return;
      }
      if (error) {
        reject(new WindowsSandboxError(`cannot spawn helper exe ${exe}: ${error.message}`));
        return;
      }
      resolve({ exitCode: 0, stdout: String(stdout), stderr: String(stderr) });
    });
    // Write + close the one-shot stdin payload. execFile spawns the child with
    // a stdin pipe; a write/ignore-error guard keeps a child that exits before
    // reading (or a spawn failure surfaced via the callback above) from
    // crashing on EPIPE.
    if (opts?.stdin !== undefined && child.stdin) {
      child.stdin.on('error', () => { /* EPIPE on early child exit — exit code is the result */ });
      child.stdin.write(opts.stdin);
      child.stdin.end();
    }
  });
}
