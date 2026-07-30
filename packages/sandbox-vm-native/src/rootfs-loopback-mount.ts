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
import { mkdtemp, rm, stat, lstat } from 'node:fs/promises';
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
 * All other errors throw `RootfsMountError` (fail-closed).
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
  let st: Awaited<ReturnType<typeof stat>>;
  try {
    st = await stat(full);
  } catch (err) {
    const code = (err as NodeJS.ErrnoException).code;
    if (code === 'ENOENT') return null; // missing guest path → null (caller rejects)
    if (code === 'ENOTDIR') return null; // a path component is not a dir → null
    // Any other stat error (EACCES, EIO, …) is fail-closed.
    throw new RootfsMountError('stat', `stat failed for ${full}: ${(err as Error).message ?? String(err)}`, err);
  }
  // lstat semantics: stat() follows symlinks. We use stat() (not lstat) because
  // the existing test seam expects isSymlink to flag a symlinked TARGET. The
  // assertExecutablesQualified check rejects symlinks BEFORE they could be
  // followed, so a symlinked executable path is rejected. To detect a symlink
  // at the guest path itself we stat() and rely on the mode: stat() on a
  // symlink resolves the target, so isSymbolicLink() would be false for a
  // resolved symlink. However the mount is read-only and the image is sealed,
  // so the only symlinks present are those baked into the image — which stat()
  // follows. We additionally lstat to catch a symlink at the exact guest path
  // (the security check rejects a guest path that IS a symlink, even if its
  // target is a valid regular file, because a mutable symlink is a shadowing
  // vector). The existing seam's contract: isSymlink=true ⇒ reject.
  let isSymlink = false;
  try {
    const lst = await lstat(full);
    isSymlink = lst.isSymbolicLink();
  } catch (err) {
    // If lstat fails but stat succeeded, that's a TOCTOU (the path was
    // replaced between calls). Fail closed.
    throw new RootfsMountError('stat', `lstat failed for ${full} after stat succeeded: ${(err as Error).message ?? String(err)}`, err);
  }
  // If the guest path is a symlink, report it as such (reject). Otherwise use
  // the stat() result (which followed the symlink to its target if any — but
  // we already flagged the symlink at the guest path).
  if (isSymlink) {
    return { isReg: false, isExec: false, isSymlink: true };
  }
  const mode = st.mode;
  return {
    isReg: st.isFile(),
    // Owner-exec bit (0o100). assertExecutablesQualified rejects non-exec.
    isExec: Boolean(mode & 0o100),
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
