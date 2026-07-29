// packages/sandbox-vm-native/src/executables-qualified.ts
import { createHash } from 'node:crypto';
import { ExecutablesUnqualifiedError } from '@agentoctopus/sandbox';

export interface ExecStatResult { isReg: boolean; isExec: boolean; isSymlink: boolean; }

export interface AssertExecutablesDeps {
  statRootfsFile(rootfsPath: string, guestPath: string): Promise<ExecStatResult | null>;
  rootfsPath: string;
}

const MOUNT_OVERRIDDEN = ['/skill', '/tmp', '/run', '/etc/skill-ca', '/dev', '/proc', '/sys'];
const BAD_BARE_NAMES = new Set(['', '.', '..']);

function isBareName(s: string): boolean {
  if (BAD_BARE_NAMES.has(s)) return false;
  if (s.includes('/')) return false;
  if (s.includes('\x00')) return false;
  return true;
}
function isCanonicalAbsolute(p: string): boolean {
  if (!p.startsWith('/')) return false;
  if (p.includes('\x00') || p.includes('/..') || p.includes('..')) return false; // simplified
  if (p.endsWith('/')) return false;
  return true;
}
function underMountOverride(p: string): boolean {
  return MOUNT_OVERRIDDEN.some((d) => p === d || p.startsWith(d + '/'));
}
function executableMapDigest(executables: Record<string, string>): string {
  // canonical: sorted keys, JSON — must match what prepare() would compute
  const sorted = Object.keys(executables).sort().map((k) => [k, executables[k]]);
  return createHash('sha256').update(JSON.stringify(sorted)).digest('hex');
}

// Module-level cache: (rootfsDigest, executableMapDigest) -> verdict
const cache = new Map<string, true>();

/** Test seam: clear the stat-walk cache between tests. */
export function _resetExecCacheForTest(): void {
  cache.clear();
}

export async function assertExecutablesQualified(
  ref: string,
  executables: Record<string, string>,
  bins: readonly string[],
  deps: AssertExecutablesDeps,
): Promise<void> {
  // R10 P1-1: CHEAP uncached set-equality check — runs EVERY call, BEFORE cache.
  const keySet = new Set(Object.keys(executables));
  const binSet = new Set(bins);
  const offending: string[] = [];
  for (const b of binSet) if (!keySet.has(b)) offending.push(`missing bin "${b}"`);
  for (const k of keySet) if (!binSet.has(k)) offending.push(`stray key "${k}"`);
  if (offending.length) throw new ExecutablesUnqualifiedError(offending);

  // Cached expensive rootfs stat-walk.
  const cacheKey = `${ref}|${executableMapDigest(executables)}`;
  if (cache.has(cacheKey)) return;

  for (const [name, guestPath] of Object.entries(executables)) {
    if (!isBareName(name)) offending.push(`bad bare name "${name}"`);
    if (!isCanonicalAbsolute(guestPath)) offending.push(`non-canonical path "${guestPath}"`);
    if (underMountOverride(guestPath)) offending.push(`under mount-override "${guestPath}"`);
  }
  if (offending.length) throw new ExecutablesUnqualifiedError(offending);

  // stat-walk each value
  for (const [name, guestPath] of Object.entries(executables)) {
    const st = await deps.statRootfsFile(deps.rootfsPath, guestPath);
    if (!st) offending.push(`missing "${name}" -> ${guestPath}`);
    else if (st.isSymlink) offending.push(`symlink "${name}" -> ${guestPath}`);
    else if (!st.isReg) offending.push(`not a regular file "${name}" -> ${guestPath}`);
    else if (!st.isExec) offending.push(`not executable "${name}" -> ${guestPath}`);
  }
  if (offending.length) throw new ExecutablesUnqualifiedError(offending);

  cache.set(cacheKey, true);
}
