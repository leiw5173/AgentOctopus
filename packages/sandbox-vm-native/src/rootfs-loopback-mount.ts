// packages/sandbox-vm-native/src/rootfs-loopback-mount.ts
// Real `statRootfsFile` for assertExecutablesQualified (HI-2).
//
// The rootfs artifact is a sealed ext4 image file. To stat a guest path inside
// it, we mount the image READ-ONLY at a per-call temp mountpoint, stat
// `<mountpoint>/<guestPath>`, then umount + rmdir. This runs on the privileged
// Linux CI lane (needs CAP_SYS_ADMIN for the loopback mount). On any other
// platform the loopback mount is unavailable, so the real stat path is never
// exercised in production (the VM backend's prepare() runs only where
// CAP_SYS_ADMIN is available).
//
// FAIL-CLOSED INVARIANT (load-bearing): a mount/umount/stat failure THROWS a
// descriptive RootfsMountError. It NEVER silently returns null or a wrong stat
// — a mount failure must never degrade to "all executables qualified", which
// would let the guest run unvetted binaries. ENOENT (guest path absent) is the
// ONLY condition that returns null (the existing assertExecutablesQualified
// treats null as "missing" → ExecutablesUnqualifiedError). Every other error
// (mount EPERM, stat EACCES, umount EBUSY, …) throws.
//
// Resource safety: umount + rmdir run in a try/finally around stat, so a
// thrown stat error does not leak the mount. A second try/finally around
// umount ensures rmdir runs even if umount fails (the umount failure itself is
// still thrown — but the temp dir is cleaned up best-effort).

import { execFile } from 'node:child_process';
import { mkdtemp, rm, lstat } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { promisify } from 'node:util';
import type { ExecStatResult } from './executables-qualified.js';

const execFileAsync = promisify(execFile);

/** Thrown on any mount/stat/umount failure (fail-closed — never silent). */
export class RootfsMountError extends Error {
  constructor(
    public readonly phase: 'mount' | 'stat' | 'umount',
    message: string,
    public readonly cause?: unknown,
  ) {
    super(message);
    this.name = 'RootfsMountError';
  }
}

/** Opaque handle to an active read-only loopback mount. */
export interface MountHandle {
  /** The absolute mountpoint path (stat guest paths relative to this). */
  mountpoint: string;
}

/** Mount the rootfs image read-only at a fresh temp mountpoint. */
export async function mountRootfsReadOnly(imagePath: string): Promise<MountHandle> {
  // Per-call temp mountpoint (0700 by default from mkdtemp). A per-call dir
  // avoids cross-call contention on a shared mountpoint (the privileged lane
  // may run parallel tests).
  const mountpoint = await mkdtemp(path.join(tmpdir(), 'oct-rootfs-mnt-'));
  try {
    // `mount -o loop,ro <image> <mountpoint>` — needs CAP_SYS_ADMIN.
    // loop: bind the image to a free loop device; ro: read-only.
    await execFileAsync('mount', ['-o', 'loop,ro', imagePath, mountpoint], {
      timeout: 15_000,
    });
  } catch (err) {
    // Fail-closed: a mount failure must never become "all executables
    // qualified". Clean up the temp dir, then throw a descriptive error.
    await rm(mountpoint, { recursive: true, force: true }).catch(() => {});
    const e = err as { stderr?: string; code?: number | string; message?: string };
    throw new RootfsMountError(
      'mount',
      `failed to mount rootfs image read-only at ${mountpoint}: ${e.stderr ?? e.message ?? String(err)}`,
      err,
    );
  }
  return { mountpoint };
}

/** Unmount a previously mounted read-only rootfs. Idempotent (ENOENT-safe). */
export async function umount(handle: MountHandle): Promise<void> {
  try {
    await execFileAsync('umount', [handle.mountpoint], { timeout: 15_000 });
  } catch (err) {
    throw new RootfsMountError(
      'umount',
      `failed to umount ${handle.mountpoint}: ${(err as { stderr?: string; message?: string }).stderr ?? (err as Error).message ?? String(err)}`,
      err,
    );
  }
}

/**
 * Stat a guest path inside a mounted read-only rootfs. Returns an
 * `ExecStatResult` describing the file type + exec bit, or `null` if the path
 * does not exist (ENOENT) — the caller treats null as "missing executable".
 *
 * Symlink detection is lstat-PRIMARY: lstat() is called first and, if the
 * guest path IS a symlink, the symlink verdict is returned WITHOUT ever
 * calling stat() (which would follow the link, potentially into the HOST
 * filesystem for absolute symlinks). ENOENT is the ONLY null-return; every
 * other error (ENOTDIR, EACCES, EIO, …) throws `RootfsMountError` (fail-closed).
 */
async function statInMount(
  handle: MountHandle,
  guestPath: string,
): Promise<ExecStatResult | null> {
  // Guest paths are canonical absolute (assertExecutablesQualified already
  // validated this). Strip the leading '/' before joining so the mountpoint
  // is preserved (path.join('/mnt', '/usr/bin/node') would ignore /mnt).
  const rel = guestPath.replace(/^\/+/, '');
  const full = path.join(handle.mountpoint, rel);

  // lstat-PRIMARY symlink detection (review Important #2). We call lstat()
  // FIRST and NEVER call stat() (which follows symlinks) when the guest path
  // IS a symlink. Rationale: a sealed image may contain an ABSOLUTE symlink
  // (e.g. /usr/bin/node → /etc/passwd). stat(full) would FOLLOW that link,
  // resolving an absolute target against the HOST root (not the mountpoint)
  // — a host-path side effect (info leak via timing/error-code) and a TOCTOU
  // window. By detecting symlinks via lstat() first and returning the symlink
  // verdict WITHOUT ever calling stat(), symlink detection is authoritative:
  // no host path is touched, and a future refactor that reorders checks cannot
  // turn an absolute-symlink guest path into "followed, isFile true, isExec
  // true → qualified" (qualification bypass). assertExecutablesQualified
  // rejects on the isSymlink field alone (executables-qualified.ts:73), so
  // stat() is never needed for the symlink verdict.
  let lst: Awaited<ReturnType<typeof lstat>>;
  try {
    lst = await lstat(full);
  } catch (err) {
    const code = (err as NodeJS.ErrnoException).code;
    if (code === 'ENOENT') return null; // missing guest path → null (caller rejects)
    // ENOTDIR and every other error (EACCES, EIO, …) are fail-closed. ENOENT
    // is the ONLY null-return, matching the documented invariant airtight
    // (review Important #1).
    throw new RootfsMountError('stat', `lstat failed for ${full}: ${(err as Error).message ?? String(err)}`, err);
  }
  if (lst.isSymbolicLink()) {
    // Guest path IS a symlink → reject. Never follow it (no stat() call).
    return { isReg: false, isExec: false, isSymlink: true };
  }
  // Not a symlink: lstat gives the true file/dir mode (no link-following
  // needed). Use lst directly — it has the same type/exec semantics as stat()
  // for non-symlink paths, with no TOCTOU gap between two syscalls.
  return {
    isReg: lst.isFile(),
    // Owner-exec bit (0o100) — the sealed image is built with a known owner;
    // checking owner-exec is stricter than any-exec (0o111) and errs toward
    // reject (a file executable only by group/other but not owner is flagged
    // unqualified). assertExecutablesQualified rejects non-exec.
    isExec: Boolean(lst.mode & 0o100),
    isSymlink: false,
  };
}

/**
 * Create a real `statRootfsFile` that mounts the rootfs image read-only per
 * call, stats the guest path, and unmounts. Conforms to the
 * `AssertExecutablesDeps.statRootfsFile` seam.
 *
 * Each call mounts at a fresh temp mountpoint (no shared mount state). The
 * umount + rmdir always run (try/finally), even if stat throws — so no mount
 * is leaked on the CI lane.
 */
export function createLoopbackStatRootfsFile(): (
  rootfsPath: string,
  guestPath: string,
) => Promise<ExecStatResult | null> {
  return async (rootfsPath: string, guestPath: string): Promise<ExecStatResult | null> => {
    // Fail-closed on non-Linux: the loopback mount is unavailable, so the real
    // stat path cannot work. If this is invoked on a non-Linux host, it means
    // the production caller mis-gated — throw rather than silently degrade.
    if (process.platform !== 'linux') {
      throw new RootfsMountError(
        'mount',
        `loopback rootfs mount is only available on Linux (got ${process.platform}); ` +
          'assertExecutablesQualified with the real statRootfsFile must run on the privileged-Linux CI lane',
      );
    }
    const handle = await mountRootfsReadOnly(rootfsPath);
    try {
      return await statInMount(handle, guestPath);
    } finally {
      // umount MUST run even if stat threw (resource leak prevention). A umount
      // failure here is thrown AFTER the stat result/error is processed? No —
      // finally runs before the value/error propagates, so a umount failure
      // THROWS here, masking a prior stat error. That's acceptable and
      // fail-closed: either error surfaces. We rmdir best-effort regardless.
      try {
        await umount(handle);
      } catch (umountErr) {
        // Best-effort cleanup of the temp dir, then rethrow the umount failure
        // (fail-closed: a leaked-but-unmounted dir is recoverable; a leaked
        // MOUNT is a real containment/resource issue that must surface).
        await rm(handle.mountpoint, { recursive: true, force: true }).catch(() => {});
        throw umountErr;
      }
      // umount succeeded; remove the now-empty temp mountpoint.
      await rm(handle.mountpoint, { recursive: true, force: true }).catch(() => {});
    }
  };
}
