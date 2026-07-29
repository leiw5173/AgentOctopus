// packages/sandbox-vm-native/tests/executables-qualified.test.ts
import { describe, it, expect, beforeEach } from 'vitest';
import { assertExecutablesQualified, _resetExecCacheForTest } from '../src/executables-qualified.js';
import { ExecutablesUnqualifiedError } from '@agentoctopus/sandbox';

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
