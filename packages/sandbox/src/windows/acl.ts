/**
 * Read-only ACL grant — TS wrapper for the helper's `grant-acl` subcommand.
 *
 * DEPRECATION NOTE (Option 3): NOT used by the production Windows node path.
 * The production model launches node under a CreateRestrictedToken-hardened
 * token (no AppContainer), so an AppContainer package ACL grant is meaningless
 * on that path — the restricted child reads the staged copy via normal file
 * ACLs. This wrapper is retained FUNCTIONAL for the LPAC selftest diagnostic
 * only (the helper's `grant-acl` subcommand still exists).
 *
 * Spawns `octopus-sandbox-helper.exe grant-acl --pkg <moniker> --path <dir>`,
 * which grants the AppContainer package read access to the given directory
 * (used for the trusted runtime closure: node.exe, bootstrap, vendored
 * undici). The helper exits 0 on success; any spawn failure or non-zero
 * exit throws a WindowsSandboxError — this path is fail-closed.
 *
 * This module is leaf-package production code: Node stdlib only.
 */
import { WindowsSandboxError } from './errors.js';
import { spawnHelper, type HelperSpawnOptions } from './helper-spawn.js';

/**
 * Grant the AppContainer package identified by `pkgMoniker` read access to
 * `dir`. Throws WindowsSandboxError when the helper is missing or exits
 * non-zero.
 */
export async function grantRead(pkgMoniker: string, dir: string, opts?: HelperSpawnOptions): Promise<void> {
  if (typeof pkgMoniker !== 'string' || pkgMoniker.length === 0) {
    throw new WindowsSandboxError('pkgMoniker must be a non-empty string');
  }
  if (typeof dir !== 'string' || dir.length === 0) {
    throw new WindowsSandboxError('dir must be a non-empty string');
  }
  const res = await spawnHelper(['grant-acl', '--pkg', pkgMoniker, '--path', dir], opts);
  if (res.exitCode !== 0) {
    throw new WindowsSandboxError(
      `helper grant-acl exited ${res.exitCode} for pkg ${pkgMoniker} path ${dir}: ${res.stderr.trim() || res.stdout.trim()}`,
    );
  }
}
