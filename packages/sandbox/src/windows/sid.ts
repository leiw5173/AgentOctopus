/**
 * Loopback capability SID derivation — TS wrapper for the helper's `sid`
 * subcommand.
 *
 * Spawns `octopus-sandbox-helper.exe sid <moniker>`, which prints the
 * loopback capability SID (S-1-15-3-*) derived from the AppContainer package
 * moniker to stdout and exits 0. Any spawn failure, non-zero exit, or
 * unparsable output throws a WindowsSandboxError — this path is fail-closed.
 *
 * This module is leaf-package production code: Node stdlib only.
 */
import { WindowsSandboxError } from './errors.js';
import { spawnHelper, type HelperSpawnOptions } from './helper-spawn.js';

const CAPABILITY_SID_RE = /^S-1-15-3-[0-9-]+$/;

/**
 * Derive the loopback capability SID for an AppContainer package moniker.
 * Throws WindowsSandboxError when the helper is missing, exits non-zero, or
 * prints anything other than a single S-1-15-3-* SID line.
 */
export async function deriveLoopbackSid(moniker: string, opts?: HelperSpawnOptions): Promise<string> {
  if (typeof moniker !== 'string' || moniker.length === 0) {
    throw new WindowsSandboxError('moniker must be a non-empty string');
  }
  const res = await spawnHelper(['sid', moniker], opts);
  if (res.exitCode !== 0) {
    throw new WindowsSandboxError(
      `helper sid exited ${res.exitCode} for moniker ${moniker}: ${res.stderr.trim() || res.stdout.trim()}`,
    );
  }
  const sid = res.stdout.trim();
  if (!CAPABILITY_SID_RE.test(sid)) {
    throw new WindowsSandboxError(
      `helper sid printed unparsable output for moniker ${moniker}: ${JSON.stringify(res.stdout)}`,
    );
  }
  return sid;
}
