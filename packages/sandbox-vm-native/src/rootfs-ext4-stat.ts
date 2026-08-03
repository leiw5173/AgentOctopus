// packages/sandbox-vm-native/src/rootfs-ext4-stat.ts
// Real `statRootfsFile` for assertExecutablesQualified on DARWIN (HI-2). The
// Linux lane stats guest executables by loopback-mounting the sealed ext4
// rootfs read-only (`createLoopbackStatRootfsFile`); macOS cannot mount ext4,
// so this seam parses the image DIRECTLY via the `vm-image-builder stat` C
// mode — no mount, no external tool.
//
// FAIL-CLOSED INVARIANT (load-bearing, mirrors rootfs-loopback-mount.ts): any
// tool failure (non-zero exit, unparseable output, spawn error) THROWS a
// RootfsMountError. It NEVER silently returns null or a wrong stat — a stat
// failure must never degrade to "all executables qualified". `null` on stdout
// (the tool's ENOENT signal) is the ONLY null-return; the caller treats null
// as "missing executable" → ExecutablesUnqualifiedError.
//
// The executed binary is the probe-verified private copy (production wires a
// lazy resolver returning engine.getVerifiedImageBuilderPath()), so the parser
// that reads the verified rootfs is itself a verified TCB artifact — never an
// independently configured / attacker-swappable path.
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import type { ExecStatResult } from './executables-qualified.js';
import { RootfsMountError } from './rootfs-loopback-mount.js';

const execFileAsync = promisify(execFile);

/**
 * Create a real `statRootfsFile` that execs `vm-image-builder stat
 * <rootfsPath> <guestPath>` and maps its one-line output to an
 * `ExecStatResult`. Conforms to the `AssertExecutablesDeps.statRootfsFile`
 * seam. `rootfsPath` is the pinned-fd path (`/dev/fd/<N>` on darwin) the
 * engine passes, so the parsed bytes are the verified inode.
 *
 * @param builderBinaryPath absolute path to the compiled `vm-image-builder`,
 * or a lazy resolver returning it (deferred until exec time so production can
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
    let stdout: string;
    try {
      ({ stdout } = await execFileAsync(bin, ['stat', rootfsPath, guestPath], { timeout: 15_000 }));
    } catch (err) {
      const e = err as { stderr?: string; message?: string };
      throw new RootfsMountError(
        'stat',
        `ext4 stat failed for ${guestPath}: ${e.stderr ?? e.message ?? String(err)}`,
        err,
      );
    }
    const line = stdout.trim();
    if (line === 'null') return null; // ENOENT — the ONLY null-return
    let parsed: { isReg?: unknown; isExec?: unknown; isSymlink?: unknown };
    try {
      parsed = JSON.parse(line);
    } catch (err) {
      throw new RootfsMountError('stat', `ext4 stat: unparseable output ${JSON.stringify(stdout)}`, err);
    }
    // Strict shape check — a missing/wrong-typed field is a parse failure
    // (fail-closed), never a silent default.
    if (
      typeof parsed.isReg !== 'number' ||
      typeof parsed.isExec !== 'number' ||
      typeof parsed.isSymlink !== 'number'
    ) {
      throw new RootfsMountError('stat', `ext4 stat: malformed verdict ${JSON.stringify(stdout)}`);
    }
    return {
      isReg: parsed.isReg === 1,
      isExec: parsed.isExec === 1,
      isSymlink: parsed.isSymlink === 1,
    };
  };
}
