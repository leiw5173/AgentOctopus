// packages/sandbox-vm-native/tests/executables-qualified.test.ts
import { describe, it, expect, beforeEach, beforeAll, afterEach } from 'vitest';
import { execFile } from 'node:child_process';
import { mkdtemp, rm, writeFile, symlink, mkdir } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { promisify } from 'node:util';
import { assertExecutablesQualified, _resetExecCacheForTest } from '../src/executables-qualified.js';
import { createLoopbackStatRootfsFile, RootfsMountError } from '../src/rootfs-loopback-mount.js';
import { ExecutablesUnqualifiedError } from '@agentoctopus/sandbox';

const execFileAsync = promisify(execFile);

const ROOTFS = '/rootfs';
const REF = 'sha256:' + 'a'.repeat(64);

beforeEach(() => _resetExecCacheForTest());

// stat seam: returns { isReg, isExec, isSymlink } for a guest path
function statMap(map: Record<string, { isReg: boolean; isExec: boolean; isSymlink: boolean }>) {
  return async (_rootfs: string, guestPath: string) => map[guestPath] ?? null;
}

describe('assertExecutablesQualified — R10 P1-1 + R9 mount-shadow', () => {
  it('passes when keys==bins and every value is a regular exec file in rootfs', async () => {
    await assertExecutablesQualified(REF, { node: '/usr/bin/node' }, ['node'], {
      statRootfsFile: statMap({ '/usr/bin/node': { isReg: true, isExec: true, isSymlink: false } }),
      rootfsPath: ROOTFS,
    });
  });

  it('rejects when a bin is missing from the map keys (set-equality, NOT at-least-covers)', async () => {
    await expect(assertExecutablesQualified(REF, { node: '/usr/bin/node' }, ['node', 'python3'], {
      statRootfsFile: statMap({ '/usr/bin/node': { isReg: true, isExec: true, isSymlink: false } }),
      rootfsPath: ROOTFS,
    })).rejects.toBeInstanceOf(ExecutablesUnqualifiedError);
  });

  it('rejects a stray key not in bins', async () => {
    await expect(assertExecutablesQualified(REF, { node: '/usr/bin/node', extra: '/usr/bin/x' }, ['node'], {
      statRootfsFile: statMap({
        '/usr/bin/node': { isReg: true, isExec: true, isSymlink: false },
        '/usr/bin/x': { isReg: true, isExec: true, isSymlink: false },
      }),
      rootfsPath: ROOTFS,
    })).rejects.toBeInstanceOf(ExecutablesUnqualifiedError);
  });

  it('R10 P1-1: a bins mismatch is NOT hidden behind a stale cache (cheap check runs every call)', async () => {
    // first call qualifies {node} against bins [node]
    const stat = statMap({ '/usr/bin/node': { isReg: true, isExec: true, isSymlink: false } });
    await assertExecutablesQualified(REF, { node: '/usr/bin/node' }, ['node'], { statRootfsFile: stat, rootfsPath: ROOTFS });
    // second call: same rootfs+map digest, but bins now [node, python3] — must STILL reject (not cached)
    await expect(assertExecutablesQualified(REF, { node: '/usr/bin/node' }, ['node', 'python3'], {
      statRootfsFile: stat, rootfsPath: ROOTFS,
    })).rejects.toBeInstanceOf(ExecutablesUnqualifiedError);
  });

  it('rejects a value that is a symlink (shadow-before-launch)', async () => {
    await expect(assertExecutablesQualified(REF, { node: '/usr/bin/node' }, ['node'], {
      statRootfsFile: statMap({ '/usr/bin/node': { isReg: true, isExec: true, isSymlink: true } }),
      rootfsPath: ROOTFS,
    })).rejects.toBeInstanceOf(ExecutablesUnqualifiedError);
  });

  it('rejects a value under a mount-overridden dir (/skill)', async () => {
    await expect(assertExecutablesQualified(REF, { node: '/skill/node' }, ['node'], {
      statRootfsFile: statMap({ '/skill/node': { isReg: true, isExec: true, isSymlink: false } }),
      rootfsPath: ROOTFS,
    })).rejects.toThrow(/mount/);
  });

  it('rejects a value not a regular file (a directory)', async () => {
    await expect(assertExecutablesQualified(REF, { node: '/usr/bin/node' }, ['node'], {
      statRootfsFile: statMap({ '/usr/bin/node': { isReg: false, isExec: false, isSymlink: false } }),
      rootfsPath: ROOTFS,
    })).rejects.toBeInstanceOf(ExecutablesUnqualifiedError);
  });

  it('rejects a bare-name key containing /', async () => {
    await expect(assertExecutablesQualified(REF, { 'a/b': '/usr/bin/node' }, ['a/b'], {
      statRootfsFile: statMap({ '/usr/bin/node': { isReg: true, isExec: true, isSymlink: false } }),
      rootfsPath: ROOTFS,
    })).rejects.toThrow();
  });

  it('caches the stat-walk: second identical call does not re-stat (stat seam counts calls)', async () => {
    let calls = 0;
    const stat = async (_r: string, _p: string) => { calls++; return { isReg: true, isExec: true, isSymlink: false }; };
    await assertExecutablesQualified(REF, { node: '/usr/bin/node' }, ['node'], { statRootfsFile: stat, rootfsPath: ROOTFS });
    await assertExecutablesQualified(REF, { node: '/usr/bin/node' }, ['node'], { statRootfsFile: stat, rootfsPath: ROOTFS });
    expect(calls).toBe(1); // second call hit the cache
  });
});

// ---------------------------------------------------------------------------
// Real statRootfsFile via read-only loopback mount (HI-2).
//
// These tests build a tiny ext4 image with mke2fs, mount it read-only via
// `mount -o loop,ro`, and run assertExecutablesQualified against the REAL
// createLoopbackStatRootfsFile() factory. They need CAP_SYS_ADMIN + mke2fs,
// which exist on the privileged-Linux CI lane (linux-x64) but NOT on macOS —
// so they are skipIf-gated to Linux AND further skipIf when mke2fs/mount are
// absent (dev hosts without the toolchain).
// ---------------------------------------------------------------------------
const isLinux = process.platform === 'linux';

async function hasBin(bin: string): Promise<boolean> {
  try {
    await execFileAsync('which', [bin]);
    return true;
  } catch {
    return false;
  }
}

/**
 * Build a tiny ext4 image at `imgPath` containing a /usr/bin/node executable.
 * Uses mke2fs with a directory tree (no root privileges needed for creation).
 * Returns the list of guest paths created inside the image.
 */
async function buildExt4Fixture(imgPath: string, stagingDir: string): Promise<void> {
  // Layout: /usr/bin/node (an executable regular file) + /usr/bin/nonexec (a
  // regular non-executable file) + /etc/empty-dir (a directory).
  await mkdir(path.join(stagingDir, 'usr', 'bin'), { recursive: true });
  await mkdir(path.join(stagingDir, 'etc'), { recursive: true });
  // A small executable script (owner-exec bit set).
  await writeFile(path.join(stagingDir, 'usr', 'bin', 'node'), '#!/bin/sh\necho node\n', { mode: 0o755 });
  // A non-executable regular file (no exec bit).
  await writeFile(path.join(stagingDir, 'usr', 'bin', 'nonexec'), 'data\n', { mode: 0o644 });
  // Build ext4 from the staging tree. -d populates from a directory.
  await execFileAsync('mke2fs', [
    '-t', 'ext4',
    '-d', stagingDir,
    '-b', '1024',
    '-L', 'octtest',
    imgPath,
    '256k',
  ]);
}

describe.skipIf(!isLinux)('real statRootfsFile via ro loopback mount (HI-2, Linux lane)', () => {
  let mke2fsAvailable = false;

  beforeAll(async () => {
    mke2fsAvailable = await hasBin('mke2fs');
  });

  // A fresh rootfs image + its digest-based ref per test (the cache keys on ref).
  let imgDir: string;
  let stagingDir: string;

  beforeEach(async () => {
    imgDir = await mkdtemp(path.join(tmpdir(), 'oct-loopback-img-'));
    stagingDir = await mkdtemp(path.join(tmpdir(), 'oct-loopback-stage-'));
  });
  afterEach(async () => {
    await rm(stagingDir, { recursive: true, force: true }).catch(() => {});
    await rm(imgDir, { recursive: true, force: true }).catch(() => {});
  });

  it('succeeds when the rootfs is mounted ro and executables exist + are exec', async () => {
    if (!mke2fsAvailable) return; // soft skip: mke2fs absent on this host
    const imgPath = path.join(imgDir, 'rootfs.ext4');
    await buildExt4Fixture(imgPath, stagingDir);
    const ref = 'sha256:' + 'b'.repeat(64); // distinct ref per test (cache key)
    const statRootfsFile = createLoopbackStatRootfsFile();
    // node is an exec regular file at /usr/bin/node → should qualify.
    await assertExecutablesQualified(ref, { node: '/usr/bin/node' }, ['node'], {
      statRootfsFile,
      rootfsPath: imgPath,
    });
  });

  it('fails when an executable path is missing in the image', async () => {
    if (!mke2fsAvailable) return;
    const imgPath = path.join(imgDir, 'rootfs.ext4');
    await buildExt4Fixture(imgPath, stagingDir);
    const ref = 'sha256:' + 'c'.repeat(64);
    const statRootfsFile = createLoopbackStatRootfsFile();
    // /usr/bin/python3 does not exist in the fixture → stat returns null → reject.
    await expect(assertExecutablesQualified(ref, { python3: '/usr/bin/python3' }, ['python3'], {
      statRootfsFile,
      rootfsPath: imgPath,
    })).rejects.toBeInstanceOf(ExecutablesUnqualifiedError);
  });

  it('fails when an executable is not in the bins allowlist', async () => {
    if (!mke2fsAvailable) return;
    const imgPath = path.join(imgDir, 'rootfs.ext4');
    await buildExt4Fixture(imgPath, stagingDir);
    const ref = 'sha256:' + 'd'.repeat(64);
    const statRootfsFile = createLoopbackStatRootfsFile();
    // bins mismatch: map has node, bins expects python3 → set-equality reject.
    await expect(assertExecutablesQualified(ref, { node: '/usr/bin/node' }, ['python3'], {
      statRootfsFile,
      rootfsPath: imgPath,
    })).rejects.toBeInstanceOf(ExecutablesUnqualifiedError);
  });

  it('fails when a guest path exists but is not executable', async () => {
    if (!mke2fsAvailable) return;
    const imgPath = path.join(imgDir, 'rootfs.ext4');
    await buildExt4Fixture(imgPath, stagingDir);
    const ref = 'sha256:' + 'e'.repeat(64);
    const statRootfsFile = createLoopbackStatRootfsFile();
    // /usr/bin/nonexec is a regular file WITHOUT the exec bit → reject.
    await expect(assertExecutablesQualified(ref, { nonexec: '/usr/bin/nonexec' }, ['nonexec'], {
      statRootfsFile,
      rootfsPath: imgPath,
    })).rejects.toBeInstanceOf(ExecutablesUnqualifiedError);
  });

  it('rejects a symlink at the guest path against the real mount (review #2/#5)', async () => {
    if (!mke2fsAvailable) return;
    const imgPath = path.join(imgDir, 'rootfs.ext4');
    // Build a fixture where /usr/bin/linker is a SYMLINK → /usr/bin/node.
    // This is the security-sensitive case from review Finding #2: the stat
    // seam must report {isSymlink:true} WITHOUT following the link, so
    // assertExecutablesQualified rejects it (executables-qualified.ts:73).
    await mkdir(path.join(stagingDir, 'usr', 'bin'), { recursive: true });
    await writeFile(path.join(stagingDir, 'usr', 'bin', 'node'), '#!/bin/sh\necho node\n', { mode: 0o755 });
    // Symlink target is RELATIVE (valid inside the image). An absolute target
    // would resolve against the host root when followed; lstat-primary never
    // follows, so either form is safe — but relative keeps the fixture portable.
    await symlink('node', path.join(stagingDir, 'usr', 'bin', 'linker'));
    await execFileAsync('mke2fs', [
      '-t', 'ext4', '-d', stagingDir, '-b', '1024', '-L', 'octtest', imgPath, '256k',
    ]);
    const ref = 'sha256:' + 'f'.repeat(64);
    const statRootfsFile = createLoopbackStatRootfsFile();
    // /usr/bin/linker is a symlink → stat reports {isSymlink:true} → reject.
    await expect(assertExecutablesQualified(ref, { linker: '/usr/bin/linker' }, ['linker'], {
      statRootfsFile,
      rootfsPath: imgPath,
    })).rejects.toBeInstanceOf(ExecutablesUnqualifiedError);
  });
});

