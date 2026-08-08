/**
 * Sandbox teardown — TS wrapper for the helper's `teardown` subcommand.
 *
 * Spawns
 *   octopus-sandbox-helper.exe teardown --job <name> --pkg <moniker>
 *     --copydir <dir>
 * which opens the named Job, terminates its process tree, confirms the
 * active-process count reaches 0, then deletes the AppContainer profile and
 * the staged per-session copy dir (helper.c cmd_teardown, ~1952).
 *
 * FAIL-CLOSED (security-critical, mirrors the helper's own invariant): the
 * helper exits NON-ZERO and LEAVES the profile + copy dir in place whenever
 * the Job cannot be confirmed dead — a live or unconfirmed-dead skill must
 * never have its gate-related state deleted out from under the companion
 * service. This wrapper therefore throws WindowsSandboxError on any non-zero
 * exit so the caller (WinSandboxBackend.cleanup) can classify the failure as
 * CONTAINMENT and keep the WFP gate installed.
 *
 * This module is leaf-package production code: Node stdlib only.
 */
import { WindowsSandboxError } from './errors.js';
import { spawnHelper, type HelperSpawnOptions } from './helper-spawn.js';

export interface TeardownSandboxArgs {
  jobName: string;
  pkgMoniker: string;
  copyDir: string;
}

/**
 * Terminate the named Job's process tree (confirmed dead) and delete the
 * AppContainer profile + staged copy dir. Throws WindowsSandboxError when the
 * helper is missing, cannot be spawned, or exits non-zero — the latter
 * includes the fail-closed "Job not confirmed dead" case, which the caller
 * must treat as a containment failure.
 */
export async function teardownSandbox(
  args: TeardownSandboxArgs,
  opts?: HelperSpawnOptions,
): Promise<void> {
  if (typeof args.jobName !== 'string' || args.jobName.length === 0) {
    throw new WindowsSandboxError('jobName must be a non-empty string');
  }
  if (typeof args.pkgMoniker !== 'string' || args.pkgMoniker.length === 0) {
    throw new WindowsSandboxError('pkgMoniker must be a non-empty string');
  }
  if (typeof args.copyDir !== 'string' || args.copyDir.length === 0) {
    throw new WindowsSandboxError('copyDir must be a non-empty string');
  }
  const res = await spawnHelper(
    ['teardown', '--job', args.jobName, '--pkg', args.pkgMoniker, '--copydir', args.copyDir],
    opts,
  );
  if (res.exitCode !== 0) {
    throw new WindowsSandboxError(
      `helper teardown exited ${res.exitCode} for job ${args.jobName} pkg ${args.pkgMoniker}: ${res.stderr.trim() || res.stdout.trim()}`,
    );
  }
}
