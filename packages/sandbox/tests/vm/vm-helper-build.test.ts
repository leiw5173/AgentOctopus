// packages/sandbox/tests/vm/vm-helper-build.test.ts
import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { mkdtemp, writeFile, chmod, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createHash } from 'node:crypto';
import { verifyVmTcb } from '../../src/vm/vm-helper-build.js';

// verifyVmTcb resolves artifact names per-platform (vm-helper-build.ts):
// libkrun.dylib / libkrunfw.dylib on darwin, libkrun.so / libkrunfw.so on
// Linux. The fixtures must name the files the platform-under-test looks up.
const LIBKRUN = process.platform === 'darwin' ? 'libkrun.dylib' : 'libkrun.so';
const LIBKRUNFW = process.platform === 'darwin' ? 'libkrunfw.dylib' : 'libkrunfw.so';

async function makeFile(dir: string, name: string, content: string, mode = 0o755) {
  const p = join(dir, name);
  await writeFile(p, content);
  await chmod(p, mode);
  return p;
}
function digest(content: string) { return createHash('sha256').update(content).digest('hex'); }

describe('vm TCB verification', () => {
  let dir: string;
  beforeEach(async () => { dir = await mkdtemp(join(tmpdir(), 'vm-tcb-')); });
  afterEach(async () => { await rm(dir, { recursive: true, force: true }); });

  it('verifies all 4 artifacts when digests/size/mode match', async () => {
    const helper = await makeFile(dir, 'sandbox-vm-helper', 'HELPER');
    const libkrun = await makeFile(dir, LIBKRUN, 'LIBKRUN', 0o644);
    const libkrunfw = await makeFile(dir, LIBKRUNFW, 'KRUNFW', 0o644);
    const imageBuilder = await makeFile(dir, 'vm-image-builder', 'BUILDER');
    const manifest = {
      schemaVersion: 1,
      artifacts: {
        helper: { sha256: digest('HELPER'), size: 6, mode: 0o755 },
        libkrun: { sha256: digest('LIBKRUN'), size: 7, mode: 0o644 },
        libkrunfw: { sha256: digest('KRUNFW'), size: 6, mode: 0o644 },
        imageBuilder: { sha256: digest('BUILDER'), size: 7, mode: 0o755 },
      },
    };
    await writeFile(join(dir, 'tcb.manifest.json'), JSON.stringify(manifest));
    const r = await verifyVmTcb({ artifactsDir: dir, manifestPath: join(dir, 'tcb.manifest.json') });
    expect(r.paths.helper).toContain('sandbox-vm-helper');
    // The returned manifest IS the one the files were verified against —
    // callers thread its digests (never re-read the manifest path).
    expect(r.manifest.artifacts.helper.sha256).toBe(digest('HELPER'));
  });

  it('throws on a tampered artifact digest', async () => {
    await makeFile(dir, 'sandbox-vm-helper', 'TAMPERED');
    await makeFile(dir, LIBKRUN, 'LIBKRUN', 0o644);
    await makeFile(dir, LIBKRUNFW, 'KRUNFW', 0o644);
    await makeFile(dir, 'vm-image-builder', 'BUILDER');
    const manifest = {
      schemaVersion: 1,
      artifacts: {
        helper: { sha256: digest('NOT-HELPER'), size: 8, mode: 0o755 },
        libkrun: { sha256: digest('LIBKRUN'), size: 7, mode: 0o644 },
        libkrunfw: { sha256: digest('KRUNFW'), size: 6, mode: 0o644 },
        imageBuilder: { sha256: digest('BUILDER'), size: 7, mode: 0o755 },
      },
    };
    await writeFile(join(dir, 'tcb.manifest.json'), JSON.stringify(manifest));
    await expect(verifyVmTcb({ artifactsDir: dir, manifestPath: join(dir, 'tcb.manifest.json') })).rejects.toThrow();
  });

  it('throws on group/world-writable artifact', async () => {
    const helper = await makeFile(dir, 'sandbox-vm-helper', 'HELPER', 0o777); // world-writable
    await makeFile(dir, LIBKRUN, 'LIBKRUN', 0o644);
    await makeFile(dir, LIBKRUNFW, 'KRUNFW', 0o644);
    await makeFile(dir, 'vm-image-builder', 'BUILDER');
    const manifest = {
      schemaVersion: 1,
      artifacts: {
        helper: { sha256: digest('HELPER'), size: 6, mode: 0o777 },
        libkrun: { sha256: digest('LIBKRUN'), size: 7, mode: 0o644 },
        libkrunfw: { sha256: digest('KRUNFW'), size: 6, mode: 0o644 },
        imageBuilder: { sha256: digest('BUILDER'), size: 7, mode: 0o755 },
      },
    };
    await writeFile(join(dir, 'tcb.manifest.json'), JSON.stringify(manifest));
    await expect(verifyVmTcb({ artifactsDir: dir, manifestPath: join(dir, 'tcb.manifest.json') })).rejects.toThrow(/writable/);
  });

  it('rejects unknown manifest schemaVersion', async () => {
    await writeFile(join(dir, 'tcb.manifest.json'), JSON.stringify({ schemaVersion: 99, artifacts: {} }));
    await expect(verifyVmTcb({ artifactsDir: dir, manifestPath: join(dir, 'tcb.manifest.json') })).rejects.toThrow();
  });
});
