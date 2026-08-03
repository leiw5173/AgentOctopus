// packages/sandbox-vm-native/src/rootfs-ext4-stat.ts
// Real `statRootfsFile` for assertExecutablesQualified on DARWIN (HI-2). The
// Linux lane stats guest executables by loopback-mounting the sealed ext4
// rootfs read-only (`createLoopbackStatRootfsFile`); macOS cannot mount ext4,
// so this seam parses the image DIRECTLY via the `vm-image-builder statfd` C
// mode — no mount, no external tool.
//
// FD-INHERITANCE (load-bearing): the engine pins the verified rootfs inode to an
// open fd in the PARENT (Node) process. A child cannot open `/dev/fd/<parentFd>`
// — that path resolves against the CHILD's own fd table, where the number is
// invalid ("Bad file descriptor"). So the rootfs fd is passed by INHERITANCE:
// the seam dup2's it into the child's stdio table at slot 3 (via spawn's
// `{ fd }` stdio option) and invokes `statfd 3`; the C tool reads from that
// already-open fd (no open(), no path lookup, no symlink window). This mirrors
// start()'s ROOTFS_INHERIT_FD=5.
//
// WHY spawn, NOT execFile: `execFile`/`execFileSync` do NOT inherit extra stdio
// fds beyond slot 2 (the child ends up with no fd 3 — verified empirically).
// `spawn`/`spawnSync` DO honor an extra `{ fd: N }` stdio entry, dup2-ing the
// parent's open fd into the child. So this seam uses spawn and manages
// stdout/stderr/exit/timeout itself.
//
// FAIL-CLOSED INVARIANT (mirrors rootfs-loopback-mount.ts): any tool failure
// (non-zero exit, signal, spawn error, timeout, unparseable output) THROWS a
// RootfsMountError. It NEVER silently returns null or a wrong stat — a stat
// failure must never degrade to "all executables qualified". `null` on stdout
// (the tool's ENOENT signal) is the ONLY null-return; the caller treats null
// as "missing executable" → ExecutablesUnqualifiedError.
//
// The executed binary is the probe-verified private copy (production wires a
// lazy resolver returning engine.getVerifiedImageBuilderPath()), so the parser
// that reads the verified rootfs is itself a verified TCB artifact — never an
// independently configured / attacker-swappable path.
import { spawn, type ChildProcess } from 'node:child_process';
import { open } from 'node:fs/promises';
import type { ExecStatResult } from './executables-qualified.js';
import { RootfsMountError } from './rootfs-loopback-mount.js';

/** Child stdio slot the pinned rootfs fd is dup2'd into; `statfd` reads this fd. */
const STATFD_CHILD_SLOT = 3;
const STATFD_TIMEOUT_MS = 15_000;

/** Run `vm-image-builder statfd` with the rootfs fd inherited at slot 3. */
function runStatFd(
  bin: string,
  rootfsFd: number,
  guestPath: string,
): Promise<{ code: number | null; signal: NodeJS.Signals | null; stdout: string; stderr: string }> {
  return new Promise((resolve, reject) => {
    // The `{ fd }` stdio entry dup2's the parent's open fd into the child at
    // slot 3 (verified at runtime). The @types/node spawn overloads don't model
    // this form, so the options object is cast.
    const options = {
      stdio: ['ignore', 'pipe', 'pipe', { fd: rootfsFd }],
    } as unknown as Parameters<typeof spawn>[2];
    const child: ChildProcess = spawn(bin, ['statfd', String(STATFD_CHILD_SLOT), guestPath], options);
    let stdout = '';
    let stderr = '';
    let settled = false;
    const timer = setTimeout(() => {
      if (settled) return;
      settled = true;
      child.kill('SIGKILL');
      reject(new Error(`statfd timed out after ${STATFD_TIMEOUT_MS}ms`));
    }, STATFD_TIMEOUT_MS);
    child.stdout?.on('data', (d) => (stdout += d));
    child.stderr?.on('data', (d) => (stderr += d));
    child.on('error', (err) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      reject(err);
    });
    child.on('close', (code, signal) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      resolve({ code, signal, stdout, stderr });
    });
  });
}

/**
 * Create a real `statRootfsFile` that runs `vm-image-builder statfd <fd>
 * <guestPath>` with the rootfs fd inherited at stdio slot 3, and maps its
 * one-line output to an `ExecStatResult`. Conforms to the
 * `AssertExecutablesDeps.statRootfsFile` seam.
 *
 * The seam signature takes a `rootfsPath`; callers pass the pinned-fd self-path
 * (`/dev/fd/<N>` on darwin, `/proc/self/fd/<N>` on linux) so the identity is the
 * verified inode. This seam re-opens THAT path (O_RDONLY — it is the caller's
 * own open fd, so reopening resolves to the same inode, no TOCTOU against a
 * swapped on-disk path) purely to obtain a fresh, inheritable fd number for the
 * child, then closes it after the run.
 *
 * @param builderBinaryPath absolute path to the compiled `vm-image-builder`,
 * or a lazy resolver returning it (deferred until run time so production can
 * resolve the probe-verified private copy AFTER probe() succeeded).
 */
export function createExt4StatRootfsFile(
  builderBinaryPath: string | (() => Promise<string>),
): (rootfsPath: string, guestPath: string) => Promise<ExecStatResult | null> {
  return async (rootfsPath: string, guestPath: string): Promise<ExecStatResult | null> => {
    const bin =
      typeof builderBinaryPath === 'function' ? await builderBinaryPath() : builderBinaryPath;
    if (!bin) {
      throw new RootfsMountError('stat', 'ext4 stat: builder binary path not configured (fail-closed)');
    }
    // Re-open the pinned-fd self-path to get a fresh fd we can hand the child.
    const fh = await open(rootfsPath, 'r');
    let result: { code: number | null; signal: NodeJS.Signals | null; stdout: string; stderr: string };
    try {
      result = await runStatFd(bin, fh.fd, guestPath);
    } catch (err) {
      throw new RootfsMountError(
        'stat',
        `ext4 stat spawn failed for ${guestPath}: ${(err as Error).message}`,
        err,
      );
    } finally {
      await fh.close().catch(() => {});
    }
    if (result.code !== 0 || result.signal !== null) {
      throw new RootfsMountError(
        'stat',
        `ext4 stat failed for ${guestPath} (exit ${result.code ?? 'null'} signal ${result.signal ?? 'none'}): ${result.stderr.trim()}`,
      );
    }
    const line = result.stdout.trim();
    if (line === 'null') return null; // ENOENT — the ONLY null-return
    let parsed: { isReg?: unknown; isExec?: unknown; isSymlink?: unknown };
    try {
      parsed = JSON.parse(line);
    } catch (err) {
      throw new RootfsMountError('stat', `ext4 stat: unparseable output ${JSON.stringify(result.stdout)}`, err);
    }
    // Strict shape check — a missing/wrong-typed field is a parse failure
    // (fail-closed), never a silent default.
    if (
      typeof parsed.isReg !== 'number' ||
      typeof parsed.isExec !== 'number' ||
      typeof parsed.isSymlink !== 'number'
    ) {
      throw new RootfsMountError('stat', `ext4 stat: malformed verdict ${JSON.stringify(result.stdout)}`);
    }
    return {
      isReg: parsed.isReg === 1,
      isExec: parsed.isExec === 1,
      isSymlink: parsed.isSymlink === 1,
    };
  };
}
