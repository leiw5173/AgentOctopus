// packages/sandbox-vm-native/tests/private-tcb-loader.test.ts
// R6-F3 REAL ELF loader test: the engine-private TCB dir must let the dynamic
// loader resolve the helper's versioned DT_NEEDED names (libkrun.so.1,
// libkrunfw.so.5) to the VERIFIED private copies — not just contain the
// unversioned files. This compiles a real shared library with SONAME
// libkrun.so.1 and a real executable that needs it, runs a full probe() (with
// the BLK exec spied), then executes the test binary with
// LD_LIBRARY_PATH=<privateDir>:
//   - with the versioned symlink present  → exit 0 (loader resolves)
//   - with the symlink removed            → non-zero (the link is load-bearing)
// Gated on Linux + a C toolchain (the SONAME shim mechanism is Linux-only;
// vendor-libkrun.mjs is a no-op on Darwin). Everywhere else this file skips.
import { describe, it, expect, afterEach, vi } from 'vitest';
import { spawnSync } from 'node:child_process';
import * as fsPromises from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { createHash } from 'node:crypto';
import { VmEngineImpl, type VmEngineDeps, type VmInstanceRaw } from '../src/engine.js';
import * as gateManifest from '@agentoctopus/sandbox/dist/vm/gate-manifest.js';
import * as tcbManifest from '@agentoctopus/sandbox/dist/vm/vm-helper-build.js';

vi.mock('@agentoctopus/sandbox/dist/vm/gate-manifest.js', () => ({
  verifyGateManifest: vi.fn(),
  isRootfsQualified: vi.fn(),
  GateManifestSchema: { parse: vi.fn() },
  verifyOuterReleaseManifest: vi.fn(),
  computeManifestDigest: vi.fn(),
}));

vi.mock('@agentoctopus/sandbox/dist/vm/vm-helper-build.js', () => ({
  verifyVmTcb: vi.fn(),
}));

const isLinux = process.platform === 'linux';
const hasCc = spawnSync('cc', ['--version'], { encoding: 'utf8' }).status === 0;

const sha256Hex = (b: Buffer) => createHash('sha256').update(b).digest('hex');

describe('private TCB dir ELF loader (R6-F3)', () => {
  const dirs: string[] = [];
  afterEach(async () => {
    while (dirs.length) {
      await fsPromises.rm(dirs.pop()!, { recursive: true, force: true }).catch(() => {});
    }
  });

  it(
    'a binary needing libkrun.so.1 loads the verified private copy via LD_LIBRARY_PATH',
    { skip: !isLinux || !hasCc },
    async () => {
      const dir = await fsPromises.mkdtemp(path.join(tmpdir(), 'oct-elf-'));
      dirs.push(dir);

      // --- Build a real shared library with SONAME libkrun.so.1 (named
      // libkrun.so, the layout vendor-libkrun.mjs produces) exporting one
      // symbol, and a real executable that links against it — its DT_NEEDED
      // is the VERSIONED name libkrun.so.1. ---
      const libSrc = path.join(dir, 'probe-lib.c');
      const exeSrc = path.join(dir, 'probe-main.c');
      await fsPromises.writeFile(libSrc, 'int oct_probe_answer(void) { return 42; }\n');
      await fsPromises.writeFile(
        exeSrc,
        'extern int oct_probe_answer(void);\nint main(void) { return oct_probe_answer() == 42 ? 0 : 1; }\n',
      );
      const libkrunPath = path.join(dir, 'libkrun.so');
      let cc = spawnSync(
        'cc',
        ['-shared', '-fPIC', '-Wl,-soname,libkrun.so.1', '-o', libkrunPath, libSrc],
        { encoding: 'utf8' },
      );
      if (cc.status !== 0) throw new Error(`lib compile failed:\n${cc.stderr}`);
      const exePath = path.join(dir, 'probe-exe');
      cc = spawnSync('cc', ['-o', exePath, exeSrc, `-L${dir}`, '-lkrun'], { encoding: 'utf8' });
      if (cc.status !== 0) throw new Error(`exe compile failed:\n${cc.stderr}`);

      // The vendor-style versioned shim in the artifacts dir.
      await fsPromises.symlink('libkrun.so', path.join(dir, 'libkrun.so.1'));

      // --- The remaining TCB artifacts as real files (contents irrelevant —
      // verifyVmTcb is mocked; probeBlkFeature is spied). ---
      const helperPath = path.join(dir, 'sandbox-vm-helper');
      const libkrunfwPath = path.join(dir, 'libkrunfw.so');
      const imageBuilderPath = path.join(dir, 'vm-image-builder');
      await fsPromises.writeFile(helperPath, 'HELPER', { mode: 0o555 });
      await fsPromises.writeFile(libkrunfwPath, 'LIBKRUNFW', { mode: 0o555 });
      await fsPromises.writeFile(imageBuilderPath, 'BUILDER', { mode: 0o555 });

      const entry = async (p: string) => {
        const b = await fsPromises.readFile(p);
        return { sha256: sha256Hex(b), size: b.length, mode: 0o555 };
      };
      const manifest = {
        artifacts: {
          helper: await entry(helperPath),
          libkrun: await entry(libkrunPath),
          libkrunfw: await entry(libkrunfwPath),
          imageBuilder: await entry(imageBuilderPath),
        },
      };
      vi.mocked(tcbManifest.verifyVmTcb).mockResolvedValue({
        paths: {
          helper: helperPath,
          libkrun: libkrunPath,
          libkrunfw: libkrunfwPath,
          imageBuilder: imageBuilderPath,
        },
        manifest,
      });
      const gateBody = {
        platform: 'linux-x64' as const,
        schemaVersion: 1 as const,
        artifacts: {
          libkrun: 'sha256:' + manifest.artifacts.libkrun.sha256,
          libkrunfw: 'sha256:' + manifest.artifacts.libkrunfw.sha256,
          helper: 'sha256:' + manifest.artifacts.helper.sha256,
          imageBuilder: 'sha256:' + manifest.artifacts.imageBuilder.sha256,
        },
        qualifiedRootfsDigests: [] as string[],
        libkrunAbi: 'v1.19.4' as const,
        blkFeatureRequired: true as const,
        gates: { G1: 'GO' as const, G2: 'GO' as const },
        gateReasons: [] as string[],
        qualifiedAt: '2026-08-01T00:00:00.000Z',
        manifestDigest: 'sha256:' + '0'.repeat(64),
      };
      vi.mocked(gateManifest.GateManifestSchema.parse).mockReturnValue(gateBody);
      vi.mocked(gateManifest.verifyGateManifest).mockReturnValue({ ok: true, reasons: [] });
      // probe() readFile()s the gate manifest from DISK before passing the
      // parsed body to the (mocked) schema — the mock only stubs parse/verify,
      // not the filesystem read. Without the on-disk file the probe dies with
      // ENOENT → available:false, gateManifest:'missing' (observed on the
      // Linux CI lane). Write the body so the read succeeds.
      await fsPromises.writeFile(
        path.join(dir, 'gate-manifest.json'),
        JSON.stringify(gateBody),
      );

      const privateDirBase = await fsPromises.mkdtemp(path.join(tmpdir(), 'oct-elf-private-'));
      dirs.push(privateDirBase);
      const engine = new VmEngineImpl(
        {
          helperPath,
          artifactsDir: dir,
          tcbManifestPath: path.join(dir, 'vm-tcb-manifest.json'),
          gateManifestPath: path.join(dir, 'gate-manifest.json'),
          rootfsDir: dir,
          privateDirBase,
        },
        {
          platform: 'linux-x64',
          pipe: () => [10, 11] as [number, number],
          dupFdCloexec: (() => { let n = 20; return () => n++; })(),
          spawn: () => ({}) as unknown as VmInstanceRaw,
        } as unknown as VmEngineDeps,
      );
      // The BLK probe itself is spied — this test exercises the ELF LOADER on
      // a binary that genuinely needs libkrun.so.1, not the helper.
      vi.spyOn(engine as any, 'probeBlkFeature').mockResolvedValue(true);

      const r = await engine.probe();
      expect(r.available).toBe(true);
      const cached = (engine as unknown as { verifiedProbe?: { privateDir: string } }).verifiedProbe!;

      // POSITIVE: with the versioned shim in the private dir, the loader
      // resolves libkrun.so.1 to the verified private copy.
      const ok = spawnSync(exePath, [], { env: { LD_LIBRARY_PATH: cached.privateDir }, encoding: 'utf8' });
      expect(ok.status).toBe(0);

      // NEGATIVE: remove the shim → the loader must FAIL (the link is
      // load-bearing; the unversioned libkrun.so copy alone is not enough).
      await fsPromises.rm(path.join(cached.privateDir, 'libkrun.so.1'));
      const fail = spawnSync(exePath, [], { env: { LD_LIBRARY_PATH: cached.privateDir }, encoding: 'utf8' });
      expect(fail.status).not.toBe(0);

      await engine.close();
    },
  );
});
