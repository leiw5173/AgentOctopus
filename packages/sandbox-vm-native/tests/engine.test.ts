// packages/sandbox-vm-native/tests/engine.test.ts
// L1 test for VmEngineImpl.start() FD-plumbing logic. The real posix_spawn
// + native pipe binding is L3 (built by scripts/build-vm-helper.mjs in Task 15);
// here we inject a fake `deps.pipe` + `deps.spawn` seam and assert the
// R9/R10 FD config is built correctly WITHOUT executing the helper:
//
//   - two createCloexecPipe() calls (H2G, G2H), read end first, write second.
//   - R10 P1-2: h2gRead/g2hWrite moved to F_DUPFD_CLOEXEC temp slots ≥10.
//   - R10 P1-2: adddup2(tempH2gRead → fd3), adddup2(tempG2hWrite → fd4)
//     with temp ≥10 ≠ 3/4 ⇒ guaranteed real dup2 (clears cloexec on target).
//   - Darwin: POSIX_SPAWN_CLOEXEC_DEFAULT attr present.
//   - bootstrapArgv asserted [launchSpecBlob] only, length===1 (libkrun supplies argv[0]).
//   - After spawn: Node closes its h2gRead + g2hWrite + temp slots; retains
//     g2hRead + h2gWrite.
//   - Ready handshake: {"ready":true} on g2hRead ⇒ resolves VmInstance.
//   - Failure paths: {"error"} frame / helper-exit-before-ready / timeout.
import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import { PassThrough } from 'node:stream';
import * as fs from 'node:fs';
import * as fsPromises from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { createHash } from 'node:crypto';
import { VmEngineImpl, type VmEngineDeps, type VmInstanceRaw } from '../src/engine.js';
import { _resetExecCacheForTest } from '../src/executables-qualified.js';
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

vi.mock('node:fs', async (importOriginal) => {
  const actual = await importOriginal<typeof import('node:fs')>();
  return {
    ...actual,
    createReadStream: vi.fn((...args: Parameters<typeof actual.createReadStream>) =>
      actual.createReadStream(...args),
    ),
  };
});

// Deterministic fake fds. Real fds would be ≥3 (0/1/2 taken), but we
// deliberately use 3/4 for the SOURCE ends to exercise the R10 P1-2
// source==target no-op guard: the engine MUST move them to temp ≥10 before
// dup2-ing into 3/4.
const H2G_READ_SRC = 3;
const H2G_WRITE_SRC = 5;
const G2H_READ_SRC = 6;
const G2H_WRITE_SRC = 4;

// A dupFdCloexec that returns DISTINCT temp slots ≥10. Used by every test
// that doesn't itself assert the dup2 config — the engine's collision guard
// (tempH2gRead !== tempG2hWrite) rejects a binding that hands back the same
// fd for both calls.
function distinctDups() {
  let n = 20;
  return () => n++;
}

interface RecordedSpawn {
  helperPath: string;
  argv: string[];
  env: NodeJS.ProcessEnv;
  // The file-actions config the engine asked the binding to install.
  fileActions: FileAction[];
  // Darwin spawn-attribute flags (POSIX_SPAWN_CLOEXEC_DEFAULT etc.).
  spawnAttrFlags: string[];
  // fds the engine told the binding to close IN THE PARENT after spawn.
  parentCloseFds: number[];
}

type FileAction =
  | { kind: 'adddup2'; src: number; target: number }
  | { kind: 'addclose'; fd: number };

// The native-binding seam the engine consumes. `pipe()` hands out our fake
// fds in the order the engine calls createCloexecPipe (H2G first, then G2H).
// `dupFdCloexec(src, min)` emulates fcntl(src, F_DUPFD_CLOEXEC, min) by
// picking the smallest fresh fd ≥ min. `spawn()` records the config and
// returns a fake child whose stdio + ready-frame behavior the test controls.
interface FakeBinding {
  pipe: () => [number, number];
  dupFdCloexec: (src: number, min: number) => number;
  spawn: (
    helperPath: string,
    argv: string[],
    env: NodeJS.ProcessEnv,
    fileActions: FileAction[],
    spawnAttrFlags: string[],
    parentCloseFds: number[],
    controlReadStream: PassThrough,
  ) => FakeChild;
}

interface FakeChild {
  stdin: PassThrough;
  stdout: PassThrough;
  stderr: PassThrough;
  // The parent's g2hRead end — ready/error/exit frames arrive here. The engine
  // reads this as `raw.controlRead`, so the fake child MUST expose the SAME
  // stream instance it writes ready/error frames into.
  controlRead: PassThrough;
  exited: Promise<{ exitCode: number; timedOut: boolean }>;
  kill: () => Promise<void>;
  close: () => Promise<void>;
}

// The fake `controlRead` stream: this IS the g2hRead end the engine reads
// ready/error/exit frames from. makeFakeChild writes its frames HERE, and the
// engine's waitForReady attaches listeners to `raw.controlRead` — so they must
// be the SAME stream instance.
function makeFakeChild(
  readyFrames: string[],
  controlReadStream: PassThrough,
  opts: { exitBeforeReady?: boolean; exitCode?: number } = {},
): FakeChild {
  const stdin = new PassThrough();
  const stdout = new PassThrough();
  const stderr = new PassThrough();
  let exitResolve!: (v: { exitCode: number; timedOut: boolean }) => void;
  const exited = new Promise<{ exitCode: number; timedOut: boolean }>((r) => {
    exitResolve = r;
  });

  const writeFrames = () => {
    for (const f of readyFrames) controlReadStream.write(f);
  };

  if (opts.exitBeforeReady) {
    // Helper dies before emitting any ready frame. Write any frames, end the
    // control channel, and resolve exited.
    queueMicrotask(() => {
      writeFrames();
      controlReadStream.end();
      exitResolve({ exitCode: opts.exitCode ?? 1, timedOut: false });
    });
  } else {
    // Ready frame(s) emitted; do NOT end controlReadStream — the helper keeps
    // g2hWrite open for the VM lifetime. The engine only sees EOF when the
    // helper exits (modeled by kill()/close() below).
    queueMicrotask(() => {
      writeFrames();
    });
  }

  return {
    stdin, stdout, stderr,
    // The engine reads this as `raw.controlRead` — expose the SAME stream
    // instance ready/error frames are written into (controlReadStream).
    controlRead: controlReadStream,
    exited,
    kill: async () => {
      controlReadStream.end();
      exitResolve({ exitCode: 137, timedOut: true });
    },
    close: async () => {
      controlReadStream.end();
      stdout.end(); stderr.end(); stdin.end();
    },
  } as unknown as FakeChild;
}

function makeDeps(
  binding: FakeBinding,
  controlReadStream: PassThrough,
  platform: VmEngineDeps['platform'] = 'darwin-arm64',
): VmEngineDeps {
  return {
    platform,
    pipe: async () => binding.pipe(),
    dupFdCloexec: async (src, min) => binding.dupFdCloexec(src, min),
    spawn: async (
      helperPath, argv, env, fileActions, spawnAttrFlags, parentCloseFds,
    ) => {
      // The binding hands back a FakeChild whose controlReadStream IS the
      // engine's controlRead — return it as the VmInstanceRaw directly.
      return binding.spawn(
        helperPath, argv, env, fileActions, spawnAttrFlags, parentCloseFds,
        controlReadStream,
      ) as unknown as VmInstanceRaw;
    },
  } as unknown as VmEngineDeps;
}

// Hand out fds in call order: H2G=[3,5], G2H=[6,4]. Picks are stable.
function fdPoolOrder(order: number[]): () => number {
  let i = 0;
  return () => order[i++];
}

function baseConfig(rootfsArtifact?: {
  ref: string; absolutePath: string; manifestDigest: string; size: number; mode: number;
}) {
  return {
    rootfsArtifact: rootfsArtifact ?? { ref: 'sha256:' + 'a'.repeat(64), absolutePath: '/fake/rootfs.img', manifestDigest: 'sha256:' + 'b'.repeat(64), size: 1, mode: 0o444 },
    skillBlockImage: { ref: 'sha256:' + 'c'.repeat(64), absolutePath: '/fake/skill.img', manifestDigest: 'sha256:' + 'd'.repeat(64), size: 1, mode: 0o444 },
    caBlockImage: { ref: 'sha256:' + 'e'.repeat(64), absolutePath: '/fake/ca.img', manifestDigest: 'sha256:' + 'f'.repeat(64), size: 1, mode: 0o444 },
    bootstrapPath: '/usr/libexec/octopus-vm-init',
    bootstrapArgv: ['PAYLOAD_BLOB'],
    vsockPort: 1234,
    vsockHostSocket: '/tmp/vsock.sock',
    memMib: 512,
    cpus: 2,
    readyTimeoutMs: 50,
    libkrunAbi: 'v1.19.4' as const,
  };
}

// --- Verified-object binding harness (R5) ---------------------------------
// start()/resolveRootfs() consume ONLY the probe()-verified state, and round 5
// binds the USED object to the VERIFIED object: probe() copies the four TCB
// artifacts into an engine-private 0700 dir (only those copies are executed/
// loaded) and resolveRootfs() pins the rootfs fd (start() inherits it, launch
// spec references /dev/fd/5). The harness writes REAL tiny files, computes
// their digests, and seeds the verifiedProbe cache exactly the way a
// successful probe() would — INCLUDING the private copies — and
// makeStartEngine() pins the rootfs fd the way a prepare() would.
const harnessDirs: string[] = [];
// Engines that pinned a rootfs fd / created a private TCB dir — closed in
// afterEach so no FileHandle is left for the GC to close (an unclosed
// FileHandle is an unhandled ERR_INVALID_STATE, failing the run).
const enginesToClose: { close(): Promise<void> }[] = [];
afterEach(async () => {
  while (enginesToClose.length) {
    await enginesToClose.pop()!.close().catch(() => {});
  }
  while (harnessDirs.length) {
    await fsPromises.rm(harnessDirs.pop()!, { recursive: true, force: true }).catch(() => {});
  }
});

const sha256Hex = (content: string | Buffer) => createHash('sha256').update(content).digest('hex');
const LIBKRUN_NAME = process.platform === 'darwin' ? 'libkrun.dylib' : 'libkrun.so';
const LIBKRUNFW_NAME = process.platform === 'darwin' ? 'libkrunfw.dylib' : 'libkrunfw.so';

async function makeStartHarness(extraQualifiedRootfsRefs: string[] = []) {
  const dir = await fsPromises.mkdtemp(path.join(tmpdir(), 'oct-harness-'));
  harnessDirs.push(dir);
  const helperPath = path.join(dir, 'sandbox-vm-helper');
  const libkrunPath = path.join(dir, LIBKRUN_NAME);
  const libkrunfwPath = path.join(dir, LIBKRUNFW_NAME);
  const imageBuilderPath = path.join(dir, 'vm-image-builder');
  await fsPromises.writeFile(helperPath, 'HELPER', { mode: 0o555 });
  await fsPromises.writeFile(libkrunPath, 'LIBKRUN', { mode: 0o555 });
  await fsPromises.writeFile(libkrunfwPath, 'LIBKRUNFW', { mode: 0o555 });
  await fsPromises.writeFile(imageBuilderPath, 'BUILDER', { mode: 0o555 });
  const rootfsRef = 'sha256:' + sha256Hex('ROOTFS-BYTES');
  // Production layout: rootfsDir/<ref> (what resolveRootfs stats + rehashes).
  const rootfsPath = path.join(dir, rootfsRef);
  await fsPromises.writeFile(rootfsPath, 'ROOTFS-BYTES', { mode: 0o444 });
  const entry = (content: string) => ({ sha256: sha256Hex(content), size: content.length, mode: 0o555 });
  const tcbManifest = {
    artifacts: {
      helper: entry('HELPER'),
      libkrun: entry('LIBKRUN'),
      libkrunfw: entry('LIBKRUNFW'),
      imageBuilder: entry('BUILDER'),
    },
  };
  const gate = {
    platform: 'darwin-arm64' as const,
    schemaVersion: 1 as const,
    artifacts: {
      libkrun: 'sha256:' + sha256Hex('LIBKRUN'),
      libkrunfw: 'sha256:' + sha256Hex('LIBKRUNFW'),
      helper: 'sha256:' + sha256Hex('HELPER'),
      imageBuilder: 'sha256:' + sha256Hex('BUILDER'),
    },
    qualifiedRootfsDigests: [rootfsRef, ...extraQualifiedRootfsRefs],
    libkrunAbi: 'v1.19.4' as const,
    blkFeatureRequired: true as const,
    gates: { G1: 'GO' as const, G2: 'GO' as const },
    gateReasons: [] as string[],
    qualifiedAt: '2026-08-01T00:00:00.000Z',
    manifestDigest: 'sha256:' + '0'.repeat(64),
  };
  return {
    dir, helperPath, libkrunPath, libkrunfwPath, imageBuilderPath, rootfsPath, rootfsRef,
    artifactsDir: dir, tcbManifest, gate,
    rootfsArtifact: {
      ref: rootfsRef, absolutePath: rootfsPath, manifestDigest: rootfsRef,
      size: 'ROOTFS-BYTES'.length, mode: 0o444,
    },
    /**
     * Seed the probe-verified cache the way a successful probe() would —
     * INCLUDING the engine-private copies round 5 binds execution to. The
     * copies mirror probe()'s copyVerifiedArtifact: same basename, 0555,
     * inside a private mkdtemp dir under the harness dir (cleaned up with it).
     */
    async seed(engine: VmEngineImpl) {
      const privateDir = await fsPromises.mkdtemp(path.join(dir, 'oct-vm-tcb-'));
      const copy = async (src: string) => {
        const dst = path.join(privateDir, path.basename(src));
        await fsPromises.copyFile(src, dst);
        await fsPromises.chmod(dst, 0o555);
        return dst;
      };
      const tcbPaths = {
        helper: await copy(helperPath),
        libkrun: await copy(libkrunPath),
        libkrunfw: await copy(libkrunfwPath),
        imageBuilder: await copy(imageBuilderPath),
      };
      (engine as unknown as { verifiedProbe: unknown }).verifiedProbe = {
        gateManifest: gate,
        tcbManifest,
        tcbPaths,
        privateDir,
      };
      return { privateDir, tcbPaths };
    },
  };
}

type StartHarness = Awaited<ReturnType<typeof makeStartHarness>>;

async function makeStartEngine(deps: VmEngineDeps): Promise<{
  engine: VmEngineImpl;
  harness: StartHarness;
  priv: { privateDir: string; tcbPaths: { helper: string; libkrun: string; libkrunfw: string; imageBuilder: string } };
}> {
  const harness = await makeStartHarness();
  const engine = new VmEngineImpl(
    {
      helperPath: harness.helperPath,
      artifactsDir: harness.artifactsDir,
      tcbManifestPath: path.join(harness.dir, 'vm-tcb-manifest.json'),
      gateManifestPath: path.join(harness.dir, 'gate-manifest.json'),
      rootfsDir: harness.dir,
    },
    deps,
  );
  const priv = await harness.seed(engine);
  // Round 5: start() requires the rootfs fd pinned by resolveRootfs() for the
  // same ref — a prepare() would have run first in production, so pin here.
  await engine.resolveRootfs(harness.rootfsRef);
  enginesToClose.push(engine);
  return { engine, harness, priv };
}

describe('VmEngineImpl.start FD plumbing (R9/R10, L1 fake-spawn seam)', () => {
  beforeEach(() => {
    _resetExecCacheForTest();
    // start() gates the rootfs ref against the probe-cached gate manifest —
    // mirror the real membership check over the seeded gate.
    vi.mocked(gateManifest.isRootfsQualified).mockImplementation(
      (m, ref) => m.qualifiedRootfsDigests.includes(ref),
    );
  });

  it('builds the R10 P1-2 dup2 config: F_DUPFD_CLOEXEC temp ≥10 then adddup2 → fd3/fd4 (source≠target)', async () => {
    const nextH2G = fdPoolOrder([H2G_READ_SRC, H2G_WRITE_SRC]);
    const nextG2H = fdPoolOrder([G2H_READ_SRC, G2H_WRITE_SRC]);
    let call = 0;
    const controlReadStream = new PassThrough();

    const binding: FakeBinding = {
      pipe: () => (call++ === 0 ? [nextH2G(), nextH2G()] : [nextG2H(), nextG2H()]),
      // fcntl(src, F_DUPFD_CLOEXEC, 10): smallest fresh fd ≥10. Each call
      // hands back the next temp slot (10, 11, ...) — deterministic.
      dupFdCloexec: () => dupCounter++,
      spawn: (helperPath, argv, _env, fileActions, spawnAttrFlags, parentCloseFds, crs) => {
        recorded = { helperPath, argv, env: _env, fileActions, spawnAttrFlags, parentCloseFds };
        return makeFakeChild(['{"ready":true}\n'], crs);
      },
    };
    let dupCounter = 10;

    let recorded!: RecordedSpawn;
    const deps = makeDeps(binding, controlReadStream);
    // Wire the control stream: the fake child writes ready frames into
    // controlReadStream; the engine reads from it.
    const { engine, harness, priv } = await makeStartEngine(deps);
    const inst = await engine.start(baseConfig(harness.rootfsArtifact) as any);

    expect(recorded).toBeDefined();
    // Helper argv contract: [helperPath, helperSpecToken], length===2.
    // Round 5: the executed helper is the ENGINE-PRIVATE verified copy, and
    // the nested bootstrapArgv is inside the base64url(JSON) spec at argv[1].
    expect(recorded.argv[0]).toBe(priv.tcbPaths.helper);
    expect(recorded.argv.length).toBe(2);
    expect(typeof recorded.argv[1]).toBe('string');
    const spec = JSON.parse(Buffer.from(recorded.argv[1], 'base64url').toString('utf8'));
    expect(spec.helperPath).toBeUndefined();
    expect(spec.bootstrapPath).toBe('/usr/libexec/octopus-vm-init');
    expect(spec.bootstrapArgv).toEqual(['PAYLOAD_BLOB']);
    // Round 5: the rootfs is attached via the inherited pinned fd, not a path.
    expect(spec.rootfsPath).toBe('/dev/fd/5');
    expect(spec.skillBlockPath).toBe('/fake/skill.img');
    expect(spec.caBlockPath).toBe('/fake/ca.img');
    expect(spec.vsockPort).toBe(1234);
    expect(spec.vsockHostSocket).toBe('/tmp/vsock.sock');
    expect(spec.memMib).toBe(512);
    expect(spec.cpus).toBe(2);
    expect(spec.trustedEnv).toEqual([]);

    const dup2s = recorded.fileActions.filter((a) => a.kind === 'adddup2') as { src: number; target: number; kind: 'adddup2' }[];
    // Exactly three adddup2: temp→3 (H2G read), temp→4 (G2H write), temp→5 (rootfs fd).
    expect(dup2s.length).toBe(3);
    const to3 = dup2s.find((d) => d.target === 3);
    const to4 = dup2s.find((d) => d.target === 4);
    const to5 = dup2s.find((d) => d.target === 5);
    expect(to3, 'an adddup2 into fd 3 (H2G_READ)').toBeDefined();
    expect(to4, 'an adddup2 into fd 4 (G2H_WRITE)').toBeDefined();
    expect(to5, 'an adddup2 into fd 5 (ROOTFS_INHERIT_FD)').toBeDefined();
    // R10 P1-2: source must be the F_DUPFD_CLOEXEC temp (≥10), NOT the raw 3/4/5.
    expect(to3!.src).toBeGreaterThanOrEqual(10);
    expect(to4!.src).toBeGreaterThanOrEqual(10);
    expect(to5!.src).toBeGreaterThanOrEqual(10);
    expect(to3!.src).not.toBe(3);
    expect(to4!.src).not.toBe(4);
    expect(to5!.src).not.toBe(5);

    // Darwin: POSIX_SPAWN_CLOEXEC_DEFAULT attr set.
    expect(recorded.spawnAttrFlags).toContain('POSIX_SPAWN_CLOEXEC_DEFAULT');

    // After spawn Node closes its own h2gRead (3) + g2hWrite (4) + temp slots.
    expect(recorded.parentCloseFds).toContain(H2G_READ_SRC);
    expect(recorded.parentCloseFds).toContain(G2H_WRITE_SRC);
    // Temp slots closed too (including the rootfs temp).
    expect(recorded.parentCloseFds).toContain(to3!.src);
    expect(recorded.parentCloseFds).toContain(to4!.src);
    expect(recorded.parentCloseFds).toContain(to5!.src);
    // Node RETAINS g2hRead + h2gWrite (must NOT be in parentCloseFds).
    expect(recorded.parentCloseFds).not.toContain(G2H_READ_SRC);
    expect(recorded.parentCloseFds).not.toContain(H2G_WRITE_SRC);

    // VmInstance exposes stdio + exited.
    expect(inst.stdin).toBeDefined();
    expect(inst.stdout).toBeDefined();
    expect(inst.stderr).toBeDefined();
    expect(typeof inst.kill).toBe('function');
    await inst.close();
  });

  async function runEnvAllowlistScenario(
    platform: VmEngineDeps['platform'],
  ): Promise<{ env: NodeJS.ProcessEnv; privateDir: string }> {
    const controlReadStream = new PassThrough();
    let recordedEnv: NodeJS.ProcessEnv | undefined;
    const binding: FakeBinding = {
      pipe: () => [10, 11],
      dupFdCloexec: distinctDups(),
      spawn: (_h, _a, env, _f, _s, _p, crs) => {
        recordedEnv = env;
        return makeFakeChild(['{"ready":true}\n'], crs);
      },
    };
    const deps = makeDeps(binding, controlReadStream, platform);
    const { engine, harness, priv } = await makeStartEngine(deps);

    const hadPath = 'PATH' in process.env;
    const originalPath = process.env.PATH;
    const originalDyld = process.env.DYLD_LIBRARY_PATH;
    const originalLd = process.env.LD_LIBRARY_PATH;
    const originalToken = process.env.GITHUB_TOKEN;
    const originalHome = process.env.HOME;
    try {
      process.env.PATH = '/test/bin';
      process.env.DYLD_LIBRARY_PATH = '/test/dyld';
      process.env.LD_LIBRARY_PATH = '/test/ld';
      process.env.GITHUB_TOKEN = 'secret-token';
      process.env.HOME = '/test/home';

      const inst = await engine.start(baseConfig(harness.rootfsArtifact) as any);
      await inst.close();
    } finally {
      if (hadPath) process.env.PATH = originalPath!;
      else delete process.env.PATH;
      if (originalDyld === undefined) delete process.env.DYLD_LIBRARY_PATH;
      else process.env.DYLD_LIBRARY_PATH = originalDyld;
      if (originalLd === undefined) delete process.env.LD_LIBRARY_PATH;
      else process.env.LD_LIBRARY_PATH = originalLd;
      if (originalToken === undefined) delete process.env.GITHUB_TOKEN;
      else process.env.GITHUB_TOKEN = originalToken;
      if (originalHome === undefined) delete process.env.HOME;
      else process.env.HOME = originalHome;
    }

    if (!recordedEnv) throw new Error('spawn was not called');
    return { env: recordedEnv, privateDir: priv.privateDir };
  }

  it('passes a minimal allowlisted env on darwin-arm64 (HI-1)', async () => {
    const { env, privateDir } = await runEnvAllowlistScenario('darwin-arm64');

    expect(env.GITHUB_TOKEN).toBeUndefined();
    expect(env.HOME).toBeUndefined();
    expect(env.LD_LIBRARY_PATH).toBeUndefined();
    expect(Object.keys(env).sort()).toEqual(
      [
        'DYLD_LIBRARY_PATH',
        'OCTOPUS_VSOCK_PORT',
        'OCTOPUS_VSOCK_HOST_SOCKET',
        'OCTOPUS_VM_CPUS',
        'OCTOPUS_VM_MEM_MIB',
        'PATH',
      ].sort(),
    );
    expect(env.PATH).toBe('/test/bin');
    expect(env.OCTOPUS_VSOCK_PORT).toBe('1234');
    expect(env.OCTOPUS_VSOCK_HOST_SOCKET).toBe('/tmp/vsock.sock');
    expect(env.OCTOPUS_VM_MEM_MIB).toBe('512');
    expect(env.OCTOPUS_VM_CPUS).toBe('2');
    // Round 5: the loader path is FORCED to the engine-private verified copies
    // (never an inherited/arbitrary path).
    expect(env.DYLD_LIBRARY_PATH).toBe(privateDir);
  });

  it('passes a minimal allowlisted env on linux-x64 (HI-1)', async () => {
    const { env, privateDir } = await runEnvAllowlistScenario('linux-x64');

    expect(env.GITHUB_TOKEN).toBeUndefined();
    expect(env.HOME).toBeUndefined();
    expect(env.DYLD_LIBRARY_PATH).toBeUndefined();
    expect(Object.keys(env).sort()).toEqual(
      [
        'LD_LIBRARY_PATH',
        'OCTOPUS_VSOCK_PORT',
        'OCTOPUS_VSOCK_HOST_SOCKET',
        'OCTOPUS_VM_CPUS',
        'OCTOPUS_VM_MEM_MIB',
        'PATH',
      ].sort(),
    );
    expect(env.PATH).toBe('/test/bin');
    expect(env.OCTOPUS_VSOCK_PORT).toBe('1234');
    expect(env.OCTOPUS_VSOCK_HOST_SOCKET).toBe('/tmp/vsock.sock');
    expect(env.OCTOPUS_VM_MEM_MIB).toBe('512');
    expect(env.OCTOPUS_VM_CPUS).toBe('2');
    expect(env.LD_LIBRARY_PATH).toBe(privateDir);
  });

  it('rejects bootstrapArgv that violates the [blob] length===1 contract', async () => {
    const controlReadStream = new PassThrough();
    const binding: FakeBinding = {
      pipe: () => [10, 11],
      dupFdCloexec: distinctDups(),
      spawn: (_h, _a, _e, _f, _s, _p, crs) => makeFakeChild(['{"ready":true}\n'], crs),
    };
    const deps = makeDeps(binding, controlReadStream);
    const { engine, harness } = await makeStartEngine(deps);
    const cfg = baseConfig(harness.rootfsArtifact);
    cfg.bootstrapArgv = ['a', 'b']; // length 2 — libkrun supplies argv[0], so only the blob belongs here
    await expect(engine.start(cfg as any)).rejects.toThrow(/bootstrapArgv/);
  });

  it('rejects bootstrapArgv[0] repeating bootstrapPath (libkrun supplies argv[0])', async () => {
    const controlReadStream = new PassThrough();
    const binding: FakeBinding = {
      pipe: () => [10, 11],
      dupFdCloexec: distinctDups(),
      spawn: (_h, _a, _e, _f, _s, _p, crs) => makeFakeChild(['{"ready":true}\n'], crs),
    };
    const deps = makeDeps(binding, controlReadStream);
    const { engine, harness } = await makeStartEngine(deps);
    const cfg = baseConfig(harness.rootfsArtifact);
    cfg.bootstrapArgv = ['/usr/libexec/octopus-vm-init']; // repeats bootstrapPath -> pushes blob off argv[1]
    await expect(engine.start(cfg as any)).rejects.toThrow(/bootstrapArgv/);
  });

  it('fails start on {"error"} frame before ready', async () => {
    const controlReadStream = new PassThrough();
    const binding: FakeBinding = {
      pipe: () => [10, 11],
      dupFdCloexec: distinctDups(),
      spawn: (_h, _a, _e, _f, _s, _p, crs) => makeFakeChild(['{"error":"bad launch spec"}\n'], crs),
    };
    const deps = makeDeps(binding, controlReadStream);
    const { engine, harness } = await makeStartEngine(deps);
    await expect(engine.start(baseConfig(harness.rootfsArtifact) as any)).rejects.toThrow(/bad launch spec/);
  });

  it('fails start when helper exits before ready', async () => {
    const controlReadStream = new PassThrough();
    const binding: FakeBinding = {
      pipe: () => [10, 11],
      dupFdCloexec: distinctDups(),
      spawn: (_h, _a, _e, _f, _s, _p, crs) => makeFakeChild([], crs, { exitBeforeReady: true, exitCode: 1 }),
    };
    const deps = makeDeps(binding, controlReadStream);
    const { engine, harness } = await makeStartEngine(deps);
    await expect(engine.start(baseConfig(harness.rootfsArtifact) as any)).rejects.toThrow(/ready|exited|before/i);
  });

  it('fails start on readyTimeoutMs timeout with no frame', async () => {
    const controlReadStream = new PassThrough();
    // A child that never writes a frame and never exits.
    const stalled: FakeChild = {
      stdin: new PassThrough(), stdout: new PassThrough(), stderr: new PassThrough(),
      controlRead: controlReadStream,
      exited: new Promise(() => {}), // never resolves
      kill: async () => {}, close: async () => {},
    };
    const binding: FakeBinding = {
      pipe: () => [10, 11],
      dupFdCloexec: distinctDups(),
      spawn: () => stalled,
    };
    const deps = makeDeps(binding, controlReadStream);
    const { engine, harness } = await makeStartEngine(deps);
    await expect(engine.start(baseConfig(harness.rootfsArtifact) as any)).rejects.toThrow(/timed out|timeout/i);
  });

  it('parses newline-less CONCATENATED control frames ({"ready":true}{"exit":0})', async () => {
    // REGRESSION (darwin vm-lane "helper closed control channel before ready"):
    // vm-init writes control frames back-to-back on the octopus-control port
    // with NO newline separator — the real wire format is a single chunk
    // `{"ready":true}{"exit":0}`. A newline-splitting waitForReady never fires
    // on such a buffer and mis-reports a healthy boot as "closed control
    // channel before ready (EOF)". The reader must extract each complete
    // top-level JSON object by brace matching and resolve ready immediately.
    const controlReadStream = new PassThrough();
    const binding: FakeBinding = {
      pipe: () => [10, 11],
      dupFdCloexec: distinctDups(),
      // One write, NO trailing newline, two frames concatenated.
      spawn: (_h, _a, _e, _f, _s, _p, crs) => makeFakeChild(['{"ready":true}{"exit":0}'], crs),
    };
    const deps = makeDeps(binding, controlReadStream);
    const { engine, harness } = await makeStartEngine(deps);
    const inst = await engine.start(baseConfig(harness.rootfsArtifact) as any);
    expect(inst.stdin).toBeDefined();
    await inst.close();
    await engine.close();
  });

  it('parses a ready frame split across two chunks', async () => {
    // The frame may also arrive fragmented mid-object; the reader must buffer
    // the partial object until the rest arrives (no premature EOF misreport).
    const controlReadStream = new PassThrough();
    const binding: FakeBinding = {
      pipe: () => [10, 11],
      dupFdCloexec: distinctDups(),
      spawn: (_h, _a, _e, _f, _s, _p, crs) => {
        const child = makeFakeChild([], crs);
        queueMicrotask(() => {
          crs.write('{"ready":tr');   // partial — must NOT throw EOF/parse
          crs.write('ue}');           // completes the frame
        });
        return child;
      },
    };
    const deps = makeDeps(binding, controlReadStream);
    const { engine, harness } = await makeStartEngine(deps);
    const inst = await engine.start(baseConfig(harness.rootfsArtifact) as any);
    expect(inst.stdin).toBeDefined();
    await inst.close();
    await engine.close();
  });

  it('bridges helper exit code into VmInstance.exited', async () => {
    const controlReadStream = new PassThrough();
    let killFn: (() => Promise<void>) | undefined;
    const binding: FakeBinding = {
      pipe: () => [10, 11],
      dupFdCloexec: distinctDups(),
      spawn: (_h, _a, _e, _f, _s, _p, crs) => {
        const c = makeFakeChild(['{"ready":true}\n'], crs);
        killFn = c.kill;
        return c;
      },
    };
    const deps = makeDeps(binding, controlReadStream);
    const { engine, harness } = await makeStartEngine(deps);
    const inst = await engine.start(baseConfig(harness.rootfsArtifact) as any);
    // Trigger a kill → exited resolves 137/timedOut.
    await inst.kill();
    const r = await inst.exited;
    expect(r.exitCode).toBe(137);
    expect(r.timedOut).toBe(true);
    await inst.close();
  });

  it('treats the guest {"exit"} control frame as authoritative over the helper exit code', async () => {
    const controlReadStream = new PassThrough();
    const binding: FakeBinding = {
      pipe: () => [10, 11],
      dupFdCloexec: distinctDups(),
      spawn: (_h, _a, _e, _f, _s, _p, crs) =>
        makeFakeChild(['{"ready":true}\n'], crs),
    };
    const deps = makeDeps(binding, controlReadStream);
    const { engine, harness } = await makeStartEngine(deps);
    const inst = await engine.start(baseConfig(harness.rootfsArtifact) as any);
    // The guest PID 1 (vm-init) reports the workload exit code over the
    // control port because libkrun's own exit-code propagation is
    // virtiofs-only (sealed ext4 root ⇒ the helper always exits 0). Report
    // a workload exit of 42, then kill: exited must surface the GUEST code,
    // not the helper's 137.
    controlReadStream.write('{"exit":42}');
    await inst.kill();
    const r = await inst.exited;
    expect(r.exitCode).toBe(42);
    expect(r.timedOut).toBe(true);
    await inst.close();
  });

  it('surfaces a post-ready bootstrap rejection ({"error"} + {"exit":127}) as exitCode 127', async () => {
    // A post-ready guest rejection (e.g. executable-allowlist miss in step 9)
    // writes {"error":"..."} + {"exit":127} and exits. Even though the helper
    // process exits 0 (virtiofs-only exit propagation), exited must be 127.
    const controlReadStream = new PassThrough();
    const binding: FakeBinding = {
      pipe: () => [10, 11],
      dupFdCloexec: distinctDups(),
      spawn: (_h, _a, _e, _f, _s, _p, crs) =>
        makeFakeChild(['{"ready":true}\n'], crs),
    };
    const deps = makeDeps(binding, controlReadStream);
    const { engine, harness } = await makeStartEngine(deps);
    const inst = await engine.start(baseConfig(harness.rootfsArtifact) as any);
    controlReadStream.write('{"error":"unresolvable executable"}{"exit":127}');
    await inst.kill();
    const r = await inst.exited;
    expect(r.exitCode).toBe(127);
    await inst.close();
  });

  // REGRESSION: a rejection that lands in the SAME chunk as the ready frame
  // ({"ready":true}{"error":...}{"exit":127} written back-to-back by vm-init)
  // must still surface exitCode 127. The exit-frame capture must be attached
  // BEFORE waitForReady detaches its own onData on the ready frame — a capture
  // attached after the handshake would never see the exit frame in that chunk
  // and would fall back to the helper's always-0 exit code, misreporting a
  // rejected exec as success.
  it('captures the {"exit"} frame even when it arrives in the SAME chunk as ready', async () => {
    const controlReadStream = new PassThrough();
    const binding: FakeBinding = {
      pipe: () => [10, 11],
      dupFdCloexec: distinctDups(),
      spawn: (_h, _a, _e, _f, _s, _p, crs) =>
        // vm-init writes ready + rejection back-to-back, no newline, one chunk.
        makeFakeChild(['{"ready":true}{"error":"unresolvable executable"}{"exit":127}'], crs),
    };
    const deps = makeDeps(binding, controlReadStream);
    const { engine, harness } = await makeStartEngine(deps);
    const inst = await engine.start(baseConfig(harness.rootfsArtifact) as any);
    await inst.kill();
    const r = await inst.exited;
    expect(r.exitCode).toBe(127);
    await inst.close();
  });

  it('passes the helper exit code through when no {"exit"} frame arrives', async () => {
    // Older guests (or a kill before the workload finishes) never write an
    // exit frame; the helper status must then pass through unchanged.
    const controlReadStream = new PassThrough();
    const binding: FakeBinding = {
      pipe: () => [10, 11],
      dupFdCloexec: distinctDups(),
      spawn: (_h, _a, _e, _f, _s, _p, crs) =>
        makeFakeChild(['{"ready":true}\n'], crs),
    };
    const deps = makeDeps(binding, controlReadStream);
    const { engine, harness } = await makeStartEngine(deps);
    const inst = await engine.start(baseConfig(harness.rootfsArtifact) as any);
    await inst.kill(); // ends the control stream (EOF) with no exit frame
    const r = await inst.exited;
    expect(r.exitCode).toBe(137);
    await inst.close();
  });

  it('kills handshake after >2 malformed non-JSON control frames (HI-4)', async () => {
    const controlReadStream = new PassThrough();
    const binding: FakeBinding = {
      pipe: () => [10, 11],
      dupFdCloexec: distinctDups(),
      spawn: (_h, _a, _e, _f, _s, _p, crs) =>
        makeFakeChild(['stderr bleed\n', 'more garbage\n', 'third strike\n'], crs),
    };
    const deps = makeDeps(binding, controlReadStream);
    const { engine, harness } = await makeStartEngine(deps);
    const cfg = { ...baseConfig(harness.rootfsArtifact), readyTimeoutMs: 5000 };
    await expect(engine.start(cfg as any)).rejects.toThrow(/3 malformed control frames/);
  });

  it('tolerates ≤2 malformed frames before a valid ready frame (HI-4)', async () => {
    const controlReadStream = new PassThrough();
    const binding: FakeBinding = {
      pipe: () => [10, 11],
      dupFdCloexec: distinctDups(),
      spawn: (_h, _a, _e, _f, _s, _p, crs) =>
        makeFakeChild(['stderr bleed\n', 'more garbage\n', '{"ready":true}\n'], crs),
    };
    const deps = makeDeps(binding, controlReadStream);
    const { engine, harness } = await makeStartEngine(deps);
    const cfg = { ...baseConfig(harness.rootfsArtifact), readyTimeoutMs: 5000 };
    const inst = await engine.start(cfg as any);
    expect(inst.stdin).toBeDefined();
    await inst.close();
  });

  it('ignores empty lines without counting them as malformed (HI-4)', async () => {
    const controlReadStream = new PassThrough();
    const binding: FakeBinding = {
      pipe: () => [10, 11],
      dupFdCloexec: distinctDups(),
      spawn: (_h, _a, _e, _f, _s, _p, crs) =>
        makeFakeChild(['\n', '\n', 'bad\n', '\n', 'bad\n', '{"ready":true}\n'], crs),
    };
    const deps = makeDeps(binding, controlReadStream);
    const { engine, harness } = await makeStartEngine(deps);
    const cfg = { ...baseConfig(harness.rootfsArtifact), readyTimeoutMs: 5000 };
    const inst = await engine.start(cfg as any);
    expect(inst.stdin).toBeDefined();
    await inst.close();
  });
});

describe('VmEngineImpl.probe() BLK feature check (HI-5)', () => {
  const sha = (c: string) => 'sha256:' + c.repeat(64);
  let tempDir: string;
  let tcbPath: string;
  let gatePath: string;
  // Round 5: probe() realpath-enforces opts.helperPath === the verifyVmTcb
  // path and copies the verified artifacts from disk, so the fixtures must be
  // REAL files — reuse the start harness (real tiny binaries + real digests).
  let harness: StartHarness;

  async function makeProbeEngine(opts: Partial<ConstructorParameters<typeof VmEngineImpl>[0]> = {}) {
    return new VmEngineImpl(
      {
        helperPath: harness.helperPath,
        artifactsDir: harness.artifactsDir,
        tcbManifestPath: tcbPath,
        gateManifestPath: gatePath,
        rootfsDir: harness.dir,
        // Engine-private verified copies land inside tempDir (cleaned up).
        privateDirBase: tempDir,
        ...opts,
      },
      {
        platform: 'darwin-arm64',
        pipe: () => [10, 11] as [number, number],
        dupFdCloexec: distinctDups(),
        spawn: () => ({}) as unknown as VmInstanceRaw,
      } as unknown as VmEngineDeps,
    );
  }

  function validGateBody() {
    return {
      platform: 'darwin-arm64' as const,
      schemaVersion: 1 as const,
      artifacts: {
        libkrun: sha('a'),
        libkrunfw: sha('b'),
        helper: sha('c'),
        imageBuilder: sha('d'),
      },
      qualifiedRootfsDigests: [] as string[],
      libkrunAbi: 'v1.19.4' as const,
      blkFeatureRequired: true as const,
      gates: { G1: 'GO' as const, G2: 'GO' as const },
      gateReasons: [] as string[],
      qualifiedAt: new Date().toISOString(),
      manifestDigest: sha('z'),
    };
  }

  beforeEach(async () => {
    vi.clearAllMocks();
    harness = await makeStartHarness();
    // Probe-time binding check (R3-F1) compares canonical digests of the
    // loaded gate manifest and the signed release-manifest body. Mirror the
    // real algorithm's observable behavior for these fixtures: the digest is
    // a pure function of the body, and validGateBody() is self-consistent, so
    // keying on the manifestDigest field gives equality for identical bodies
    // and inequality for distinct ones — which is all the binding test needs.
    vi.mocked(gateManifest.computeManifestDigest).mockImplementation(
      (m) => (m as { manifestDigest?: string }).manifestDigest ?? '',
    );
    // verifyVmTcb returns the REAL harness paths + the manifest body it
    // "verified" them against — probe() threads THESE digests into the gate
    // check (never re-reads the manifest path) and realpath-binds
    // opts.helperPath to paths.helper before any exec.
    vi.mocked(tcbManifest.verifyVmTcb).mockResolvedValue({
      paths: {
        helper: harness.helperPath,
        libkrun: harness.libkrunPath,
        libkrunfw: harness.libkrunfwPath,
        imageBuilder: harness.imageBuilderPath,
      },
      manifest: harness.tcbManifest,
    });
    tempDir = await fsPromises.mkdtemp(path.join(tmpdir(), 'oct-probe-'));
    tcbPath = path.join(tempDir, 'tcb.json');
    gatePath = path.join(tempDir, 'gate.json');
    await fsPromises.writeFile(tcbPath, JSON.stringify({ schemaVersion: 1, artifacts: harness.tcbManifest.artifacts }));
    await fsPromises.writeFile(gatePath, '{}');
  });

  afterEach(async () => {
    await fsPromises.rm(tempDir, { recursive: true, force: true }).catch(() => {});
  });

  it('returns available:false when BLK feature is absent', async () => {
    const gateBody = validGateBody();
    vi.mocked(gateManifest.GateManifestSchema.parse).mockReturnValue(gateBody);
    vi.mocked(gateManifest.verifyGateManifest).mockReturnValue({ ok: true, reasons: [] });
    const engine = await makeProbeEngine();
    vi.spyOn(engine as any, 'probeBlkFeature').mockResolvedValue(false);

    const r = await engine.probe();
    expect(r.available).toBe(false);
    expect(r.blkFeature).toBe('absent');
    expect(r.reason).toMatch(/BLK|block|libkrun/i);
    expect(r.gateManifest).toBe('verified');
  });

  it('returns available:true when BLK feature is present', async () => {
    const gateBody = validGateBody();
    vi.mocked(gateManifest.GateManifestSchema.parse).mockReturnValue(gateBody);
    vi.mocked(gateManifest.verifyGateManifest).mockReturnValue({ ok: true, reasons: [] });
    const engine = await makeProbeEngine();
    const spy = vi.spyOn(engine as any, 'probeBlkFeature').mockResolvedValue(true);

    const r = await engine.probe();
    expect(r.available).toBe(true);
    expect(r.blkFeature).toBe('present');
    expect(r.gateManifest).toBe('verified');
    expect(r.releaseManifest).toBe('missing');
    // F2 (round 6): the BLK probe execs the PRIVATE verified copy with the
    // loader path pointed at the private dir — NEVER the original path
    // (a realpath→exec swap of the original would otherwise run unverified).
    expect(spy).toHaveBeenCalledTimes(1);
    const [calledHelper, calledLibDir] = spy.mock.calls[0] as unknown as [string, string];
    expect(calledHelper).not.toBe(harness.helperPath);
    expect(path.basename(calledHelper)).toBe('sandbox-vm-helper');
    expect(calledHelper.startsWith(tempDir)).toBe(true); // privateDirBase
    expect(calledLibDir).toBe(path.dirname(calledHelper));
    expect(await fsPromises.readFile(calledHelper, 'utf8')).toBe('HELPER');
  });

  // F2 (round 6): any probe failure AFTER the private copies are created
  // must discard the private dir — no half-verified private TCB left behind.
  it('F2: a probe failure after private-copy creation discards the private dir', async () => {
    const gateBody = validGateBody();
    vi.mocked(gateManifest.GateManifestSchema.parse).mockReturnValue(gateBody);
    // Gate verification fails AFTER the copies are made (copies precede the
    // gate check in the reordered probe).
    vi.mocked(gateManifest.verifyGateManifest).mockReturnValue({ ok: false, reasons: ['tampered'] });
    const engine = await makeProbeEngine();
    vi.spyOn(engine as any, 'probeBlkFeature').mockResolvedValue(true);

    const r = await engine.probe();
    expect(r.available).toBe(false);
    const leftovers = (await fsPromises.readdir(tempDir)).filter((e) => e.startsWith('oct-vm-tcb-'));
    expect(leftovers).toEqual([]);
  });

  // F3 (round 6): the private dir must recreate the versioned SONAME shims
  // (libkrun.so.1 → libkrun.so) pointing at the VERIFIED private copies —
  // the helper's DT_NEEDED uses versioned names, so without them the loader
  // misses (or falls back to unverified system libs). An attacker-crafted
  // link target in the artifacts dir must NOT be honored.
  it('F3: private dir recreates versioned SONAME links at the verified copies', async () => {
    const gateBody = validGateBody();
    vi.mocked(gateManifest.GateManifestSchema.parse).mockReturnValue(gateBody);
    vi.mocked(gateManifest.verifyGateManifest).mockReturnValue({ ok: true, reasons: [] });
    // Simulate the vendor-created versioned shims — one legit, one hostile
    // (points at an arbitrary file; the recreated link must NOT follow it).
    await fsPromises.symlink(
      path.basename(harness.libkrunPath),
      path.join(harness.artifactsDir, 'libkrun.so.1'),
    );
    await fsPromises.symlink(
      '/etc/passwd',
      path.join(harness.artifactsDir, 'libkrunfw.so.5'),
    );
    const engine = await makeProbeEngine();
    vi.spyOn(engine as any, 'probeBlkFeature').mockResolvedValue(true);

    const r = await engine.probe();
    expect(r.available).toBe(true);
    const cached = (engine as unknown as { verifiedProbe?: { privateDir: string; tcbPaths: { libkrun: string; libkrunfw: string } } }).verifiedProbe!;
    for (const [link, libKey] of [['libkrun.so.1', 'libkrun'], ['libkrunfw.so.5', 'libkrunfw']] as const) {
      const linkPath = path.join(cached.privateDir, link);
      // A relative symlink whose target is the private copy's basename…
      expect(await fsPromises.readlink(linkPath)).toBe(path.basename(cached.tcbPaths[libKey]));
      // …resolving to the verified bytes (never the hostile /etc/passwd).
      expect(await fsPromises.readFile(linkPath, 'utf8')).toBe(libKey === 'libkrun' ? 'LIBKRUN' : 'LIBKRUNFW');
    }
    await engine.close();
  });

  it('fails closed when the BLK probe itself throws', async () => {
    const gateBody = validGateBody();
    vi.mocked(gateManifest.GateManifestSchema.parse).mockReturnValue(gateBody);
    vi.mocked(gateManifest.verifyGateManifest).mockReturnValue({ ok: true, reasons: [] });
    const engine = await makeProbeEngine();
    vi.spyOn(engine as any, 'probeBlkFeature').mockRejectedValue(new Error('exec ENOENT'));

    const r = await engine.probe();
    expect(r.available).toBe(false);
    expect(r.blkFeature).toBe('absent');
    expect(r.reason).toMatch(/BLK|probe/i);
  });

  // F1 (round 5): a configured helperPath that does not realpath-resolve to
  // the verifyVmTcb()-verified helper must fail closed BEFORE any exec —
  // otherwise the BLK probe (and later start()) would execute an unverified
  // binary while TCB verification covered a different file.
  it('F1: a helperPath diverging from the verified helper fails closed before any exec', async () => {
    const gateBody = validGateBody();
    vi.mocked(gateManifest.GateManifestSchema.parse).mockReturnValue(gateBody);
    vi.mocked(gateManifest.verifyGateManifest).mockReturnValue({ ok: true, reasons: [] });
    // A real file that is NOT the verified helper.
    const otherHelper = path.join(tempDir, 'attacker-helper');
    await fsPromises.writeFile(otherHelper, 'EVIL', { mode: 0o555 });
    const engine = await makeProbeEngine({ helperPath: otherHelper });
    const spy = vi.spyOn(engine as any, 'probeBlkFeature').mockResolvedValue(true);

    const r = await engine.probe();
    expect(r.available).toBe(false);
    expect(r.reason).toMatch(/does not resolve to the verified TCB helper/);
    // Fail-closed BEFORE any exec — the divergent binary never ran.
    expect(spy).not.toHaveBeenCalled();
  });

  // F3: when a release manifest is PRESENT (both files wired), the verifier's
  // 'bad-signature' and 'no-key' results must BOTH fail closed with
  // releaseManifest:'signature-invalid' + available:false. A present-but-
  // unverifiable signature is not a capability probe — it means a signed
  // release shipped but the trust root (release-key.ts) was never committed
  // (no-key), or the signature is wrong/tampered (bad-signature). The empty
  // placeholder bootstrap must fail loud until RELEASE_PUBLIC_KEY_BASE64 is set.
  it('F3: a present release manifest with a bad signature fails closed', async () => {
    const gateBody = validGateBody();
    vi.mocked(gateManifest.GateManifestSchema.parse).mockReturnValue(gateBody);
    vi.mocked(gateManifest.verifyGateManifest).mockReturnValue({ ok: true, reasons: [] });
    const releaseManifest = path.join(tempDir, 'release-manifest.json');
    const releaseSig = path.join(tempDir, 'release-manifest.json.sig');
    await fsPromises.writeFile(releaseManifest, JSON.stringify(gateBody));
    await fsPromises.writeFile(releaseSig, Buffer.alloc(64, 0).toString('base64') + '\n');
    vi.mocked(gateManifest.verifyOuterReleaseManifest).mockReturnValue({ ok: false, reason: 'bad-signature' });
    const engine = await makeProbeEngine({ releaseManifestPath: releaseManifest, releaseManifestSignaturePath: releaseSig });
    vi.spyOn(engine as any, 'probeBlkFeature').mockResolvedValue(true);

    const r = await engine.probe();
    expect(r.available).toBe(false);
    expect(r.releaseManifest).toBe('signature-invalid');
    expect(r.reason).toMatch(/signature invalid/i);
  });

  it('F3: a present release manifest with no committed trust root (no-key) fails closed', async () => {
    const gateBody = validGateBody();
    vi.mocked(gateManifest.GateManifestSchema.parse).mockReturnValue(gateBody);
    vi.mocked(gateManifest.verifyGateManifest).mockReturnValue({ ok: true, reasons: [] });
    const releaseManifest = path.join(tempDir, 'release-manifest.json');
    const releaseSig = path.join(tempDir, 'release-manifest.json.sig');
    await fsPromises.writeFile(releaseManifest, JSON.stringify(gateBody));
    await fsPromises.writeFile(releaseSig, Buffer.alloc(64, 0).toString('base64') + '\n');
    vi.mocked(gateManifest.verifyOuterReleaseManifest).mockReturnValue({ ok: false, reason: 'no-key' });
    const engine = await makeProbeEngine({ releaseManifestPath: releaseManifest, releaseManifestSignaturePath: releaseSig });
    vi.spyOn(engine as any, 'probeBlkFeature').mockResolvedValue(true);

    const r = await engine.probe();
    expect(r.available).toBe(false);
    expect(r.releaseManifest).toBe('signature-invalid');
    expect(r.reason).toMatch(/trust root key not committed|no-key/i);
  });

  it('F3: a present release manifest with a valid signature verifies (releaseManifest:verified)', async () => {
    const gateBody = validGateBody();
    vi.mocked(gateManifest.GateManifestSchema.parse).mockReturnValue(gateBody);
    vi.mocked(gateManifest.verifyGateManifest).mockReturnValue({ ok: true, reasons: [] });
    const releaseManifest = path.join(tempDir, 'release-manifest.json');
    const releaseSig = path.join(tempDir, 'release-manifest.json.sig');
    await fsPromises.writeFile(releaseManifest, JSON.stringify(gateBody));
    await fsPromises.writeFile(releaseSig, Buffer.alloc(64, 0).toString('base64') + '\n');
    vi.mocked(gateManifest.verifyOuterReleaseManifest).mockReturnValue({ ok: true, reason: 'ok' });
    const engine = await makeProbeEngine({ releaseManifestPath: releaseManifest, releaseManifestSignaturePath: releaseSig });
    vi.spyOn(engine as any, 'probeBlkFeature').mockResolvedValue(true);

    const r = await engine.probe();
    expect(r.available).toBe(true);
    expect(r.releaseManifest).toBe('verified');
  });

  it('F3: with NO release manifest files wired, releaseManifest stays missing (soft dev-box path)', async () => {
    const gateBody = validGateBody();
    vi.mocked(gateManifest.GateManifestSchema.parse).mockReturnValue(gateBody);
    vi.mocked(gateManifest.verifyGateManifest).mockReturnValue({ ok: true, reasons: [] });
    // No releaseManifestPath / releaseManifestSignaturePath in opts.
    const engine = await makeProbeEngine();
    vi.spyOn(engine as any, 'probeBlkFeature').mockResolvedValue(true);

    const r = await engine.probe();
    expect(r.available).toBe(true);
    expect(r.releaseManifest).toBe('missing');
    expect(gateManifest.verifyOuterReleaseManifest).not.toHaveBeenCalled();
  });

  // F4/R3-F2: buildEngineOpts ALWAYS fills both release-manifest paths with
  // prebuilds defaults, so the production wiring is indistinguishable from a
  // dev box with no signed manifest by the paths alone. probe() must
  // existence-check the files; when NEITHER is present and the engine is not
  // built with requireReleaseSignature (dev box, vm-lane CI harness), it
  // soft-degrades to 'missing' — NOT readFile ENOENT in the outer catch.
  // (requireReleaseSignature:true — production assembly — fails closed on the
  // same absent pair; see the R3-F2 test below.)
  it('F4: paths wired but both files absent → soft missing, probe stays available', async () => {
    const gateBody = validGateBody();
    vi.mocked(gateManifest.GateManifestSchema.parse).mockReturnValue(gateBody);
    vi.mocked(gateManifest.verifyGateManifest).mockReturnValue({ ok: true, reasons: [] });
    const engine = await makeProbeEngine({
      releaseManifestPath: path.join(tempDir, 'release-manifest.json'),
      releaseManifestSignaturePath: path.join(tempDir, 'release-manifest.json.sig'),
    });
    vi.spyOn(engine as any, 'probeBlkFeature').mockResolvedValue(true);

    const r = await engine.probe();
    expect(r.available).toBe(true);
    expect(r.releaseManifest).toBe('missing');
    expect(r.gateManifest).toBe('verified');
    expect(gateManifest.verifyOuterReleaseManifest).not.toHaveBeenCalled();
  });

  // R3-F2 (reverses the old F4 half-pair test): a half-pair — exactly one of
  // release-manifest.json / .sig present — must FAIL CLOSED. The producer
  // writes both files atomically and the pack job enforces both, so a
  // half-pair only exists through deletion or a half-shipped release; letting
  // it soft-degrade to 'missing' let an attacker bypass the release trust
  // root by deleting the .sig.
  it('R3-F2: only the manifest present (sig deleted) → fails closed', async () => {
    const gateBody = validGateBody();
    vi.mocked(gateManifest.GateManifestSchema.parse).mockReturnValue(gateBody);
    vi.mocked(gateManifest.verifyGateManifest).mockReturnValue({ ok: true, reasons: [] });
    const releaseManifest = path.join(tempDir, 'release-manifest.json');
    await fsPromises.writeFile(releaseManifest, JSON.stringify(gateBody));
    // Signature file deliberately absent.
    const engine = await makeProbeEngine({
      releaseManifestPath: releaseManifest,
      releaseManifestSignaturePath: path.join(tempDir, 'release-manifest.json.sig'),
    });
    vi.spyOn(engine as any, 'probeBlkFeature').mockResolvedValue(true);

    const r = await engine.probe();
    expect(r.available).toBe(false);
    expect(r.releaseManifest).toBe('signature-invalid');
    expect(r.reason).toMatch(/pair incomplete/i);
    expect(gateManifest.verifyOuterReleaseManifest).not.toHaveBeenCalled();
  });

  it('R3-F2: only the signature present (manifest deleted) → fails closed', async () => {
    const gateBody = validGateBody();
    vi.mocked(gateManifest.GateManifestSchema.parse).mockReturnValue(gateBody);
    vi.mocked(gateManifest.verifyGateManifest).mockReturnValue({ ok: true, reasons: [] });
    const releaseSig = path.join(tempDir, 'release-manifest.json.sig');
    await fsPromises.writeFile(releaseSig, Buffer.alloc(64, 0).toString('base64') + '\n');
    // Manifest file deliberately absent.
    const engine = await makeProbeEngine({
      releaseManifestPath: path.join(tempDir, 'release-manifest.json'),
      releaseManifestSignaturePath: releaseSig,
    });
    vi.spyOn(engine as any, 'probeBlkFeature').mockResolvedValue(true);

    const r = await engine.probe();
    expect(r.available).toBe(false);
    expect(r.releaseManifest).toBe('signature-invalid');
    expect(r.reason).toMatch(/pair incomplete/i);
  });

  it('R3-F2: a read failure between existsSync and readFile (TOCTOU deletion) fails closed', async () => {
    const gateBody = validGateBody();
    vi.mocked(gateManifest.GateManifestSchema.parse).mockReturnValue(gateBody);
    vi.mocked(gateManifest.verifyGateManifest).mockReturnValue({ ok: true, reasons: [] });
    // A DIRECTORY at the manifest path passes existsSync but makes readFile
    // throw EISDIR — standing in for a file deleted mid-probe. The old code
    // soft-degraded on ENOENT here; any read error must now fail closed.
    const releaseManifest = path.join(tempDir, 'release-manifest.json');
    await fsPromises.mkdir(releaseManifest);
    await fsPromises.writeFile(releaseManifest + '.sig', Buffer.alloc(64, 0).toString('base64') + '\n');
    const engine = await makeProbeEngine({
      releaseManifestPath: releaseManifest,
      releaseManifestSignaturePath: releaseManifest + '.sig',
    });
    vi.spyOn(engine as any, 'probeBlkFeature').mockResolvedValue(true);

    const r = await engine.probe();
    expect(r.available).toBe(false);
    expect(r.releaseManifest).toBe('signature-invalid');
    expect(r.reason).toMatch(/unreadable during probe/i);
  });

  it('R3-F2: requireReleaseSignature + absent pair → fails closed (release build marker)', async () => {
    const gateBody = validGateBody();
    vi.mocked(gateManifest.GateManifestSchema.parse).mockReturnValue(gateBody);
    vi.mocked(gateManifest.verifyGateManifest).mockReturnValue({ ok: true, reasons: [] });
    // Production assembly (core buildEngineOpts) sets requireReleaseSignature;
    // deleting BOTH files from an installed release must not roll it back to
    // the soft 'missing' dev-box path.
    const engine = await makeProbeEngine({
      releaseManifestPath: path.join(tempDir, 'release-manifest.json'),
      releaseManifestSignaturePath: path.join(tempDir, 'release-manifest.json.sig'),
      requireReleaseSignature: true,
    });
    vi.spyOn(engine as any, 'probeBlkFeature').mockResolvedValue(true);

    const r = await engine.probe();
    expect(r.available).toBe(false);
    expect(r.releaseManifest).toBe('missing');
    expect(r.gateManifest).toBe('verified');
    expect(r.reason).toMatch(/requireReleaseSignature|required/i);
    expect(gateManifest.verifyOuterReleaseManifest).not.toHaveBeenCalled();
  });

  // R3-F1: the Ed25519 signature covers the release-manifest bytes alone;
  // probe() must BIND those bytes to the gate manifest it actually loaded and
  // verified. Otherwise an attacker keeps a legitimately-signed OLD release
  // manifest while swapping gate-manifest.json + TCB manifest + binaries: the
  // gate self-hash passes and the signature verifies an unrelated file.
  it('R3-F1: a valid signature over a DIFFERENT gate manifest fails closed (binding)', async () => {
    const gateBody = validGateBody();
    // Same shape, different canonical digest — an attacker's swapped-in gate
    // manifest that is self-consistent with replaced binaries.
    const swappedBody = { ...validGateBody(), manifestDigest: sha('y'), qualifiedAt: '2020-01-01T00:00:00.000Z' };
    vi.mocked(gateManifest.GateManifestSchema.parse)
      .mockReturnValueOnce(gateBody)     // step (2): loading gate-manifest.json
      .mockReturnValueOnce(swappedBody); // step (3): parsing the signed body
    vi.mocked(gateManifest.verifyGateManifest).mockReturnValue({ ok: true, reasons: [] });
    vi.mocked(gateManifest.verifyOuterReleaseManifest).mockReturnValue({ ok: true, reason: 'ok' });
    const releaseManifest = path.join(tempDir, 'release-manifest.json');
    const releaseSig = path.join(tempDir, 'release-manifest.json.sig');
    await fsPromises.writeFile(releaseManifest, JSON.stringify(swappedBody));
    await fsPromises.writeFile(releaseSig, Buffer.alloc(64, 0).toString('base64') + '\n');
    const engine = await makeProbeEngine({ releaseManifestPath: releaseManifest, releaseManifestSignaturePath: releaseSig });
    vi.spyOn(engine as any, 'probeBlkFeature').mockResolvedValue(true);

    const r = await engine.probe();
    expect(r.available).toBe(false);
    expect(r.releaseManifest).toBe('signature-invalid');
    expect(r.reason).toMatch(/does not bind|digest mismatch/i);
  });

  it('R3-F1: a signed body that fails schema parse fails closed', async () => {
    const gateBody = validGateBody();
    vi.mocked(gateManifest.GateManifestSchema.parse)
      .mockReturnValueOnce(gateBody) // step (2): gate-manifest.json loads fine
      .mockImplementationOnce(() => {
        throw new Error('strict schema reject');
      });
    vi.mocked(gateManifest.verifyGateManifest).mockReturnValue({ ok: true, reasons: [] });
    vi.mocked(gateManifest.verifyOuterReleaseManifest).mockReturnValue({ ok: true, reason: 'ok' });
    const releaseManifest = path.join(tempDir, 'release-manifest.json');
    const releaseSig = path.join(tempDir, 'release-manifest.json.sig');
    await fsPromises.writeFile(releaseManifest, '{"not":"a gate manifest"}');
    await fsPromises.writeFile(releaseSig, Buffer.alloc(64, 0).toString('base64') + '\n');
    const engine = await makeProbeEngine({ releaseManifestPath: releaseManifest, releaseManifestSignaturePath: releaseSig });
    vi.spyOn(engine as any, 'probeBlkFeature').mockResolvedValue(true);

    const r = await engine.probe();
    expect(r.available).toBe(false);
    expect(r.releaseManifest).toBe('signature-invalid');
    expect(r.reason).toMatch(/not a valid gate manifest/i);
  });

  // R4/R5: a successful probe caches the verified TCB/gate state — the ONLY
  // source resolveRootfs()/assertRootfsQualified()/start() may consult — and
  // round 5 binds execution to ENGINE-PRIVATE COPIES of the verified bytes.
  it('R4/R5: a successful probe caches verified state + private TCB copies', async () => {
    const gateBody = validGateBody();
    vi.mocked(gateManifest.GateManifestSchema.parse).mockReturnValue(gateBody);
    vi.mocked(gateManifest.verifyGateManifest).mockReturnValue({ ok: true, reasons: [] });
    const engine = await makeProbeEngine();
    vi.spyOn(engine as any, 'probeBlkFeature').mockResolvedValue(true);

    const r = await engine.probe();
    expect(r.available).toBe(true);
    const cached = (engine as unknown as { verifiedProbe?: {
      gateManifest: unknown;
      tcbPaths: { helper: string; imageBuilder: string };
      tcbManifest: { artifacts: { helper: { sha256: string } } };
      privateDir: string;
    } }).verifiedProbe;
    expect(cached).toBeDefined();
    expect(cached!.gateManifest).toBe(gateBody);
    expect(cached!.tcbManifest.artifacts.helper.sha256).toBe(harness.tcbManifest.artifacts.helper.sha256);
    // Round 5: tcbPaths are the engine-private COPIES (inside privateDirBase),
    // NOT the original on-disk paths — and they carry the verified bytes.
    expect(cached!.tcbPaths.helper).not.toBe(harness.helperPath);
    expect(cached!.tcbPaths.helper.startsWith(cached!.privateDir)).toBe(true);
    expect(cached!.privateDir.startsWith(tempDir)).toBe(true);
    expect(await fsPromises.readFile(cached!.tcbPaths.helper, 'utf8')).toBe('HELPER');
    expect(await fsPromises.readFile(cached!.tcbPaths.imageBuilder, 'utf8')).toBe('BUILDER');
    // The private dir is engine-exclusive (0700).
    const st = await fsPromises.stat(cached!.privateDir);
    expect(st.mode & 0o777).toBe(0o700);
    // getVerifiedImageBuilderPath hands out the private verified builder.
    expect(await engine.getVerifiedImageBuilderPath()).toBe(cached!.tcbPaths.imageBuilder);
  });
});

describe('VmEngineImpl.resolveRootfs() streaming digest (LO-1)', () => {
  async function tempRootfs(content: Buffer) {
    const dir = await fsPromises.mkdtemp(path.join(tmpdir(), 'oct-rootfs-'));
    harnessDirs.push(dir);
    const ref = 'sha256:' + createHash('sha256').update(content).digest('hex');
    const absolutePath = path.join(dir, ref);
    await fsPromises.writeFile(absolutePath, content, { mode: 0o444 });
    return { dir, ref, absolutePath };
  }

  async function makeResolveEngine(harness: StartHarness, gatePath: string, rootfsDir: string) {
    const engine = new VmEngineImpl(
      {
        helperPath: harness.helperPath,
        artifactsDir: harness.artifactsDir,
        tcbManifestPath: path.join(harness.dir, 'vm-tcb-manifest.json'),
        gateManifestPath: gatePath,
        rootfsDir,
      },
      {
        platform: 'darwin-arm64',
        pipe: () => [10, 11] as [number, number],
        dupFdCloexec: distinctDups(),
        spawn: () => ({}) as unknown as VmInstanceRaw,
      } as unknown as VmEngineDeps,
    );
    // resolveRootfs consumes ONLY the probe()-cached gate/TCB state (seeded
    // here) — it never re-reads the on-disk gate manifest.
    await harness.seed(engine);
    enginesToClose.push(engine);
    return engine;
  }

  beforeEach(() => {
    vi.clearAllMocks();
    vi.mocked(gateManifest.isRootfsQualified).mockImplementation(
      (m, ref) => m.qualifiedRootfsDigests.includes(ref),
    );
  });

  it('hashes the rootfs from an open O_NOFOLLOW fd (streaming, not readFile)', async () => {
    const content = Buffer.from('hello streaming rootfs');
    const { dir, ref, absolutePath } = await tempRootfs(content);
    const harness = await makeStartHarness([ref]);
    // The on-disk gate file is IRRELEVANT post-probe — an empty file proves
    // resolveRootfs never reads it (cached gate only).
    const gatePath = path.join(dir, 'gate.json');
    await fsPromises.writeFile(gatePath, '{}');

    const createReadStreamSpy = fs.createReadStream;

    const engine = await makeResolveEngine(harness, gatePath, dir);
    const artifact = await engine.resolveRootfs(ref);

    expect(artifact.ref).toBe(ref);
    expect(artifact.absolutePath).toBe(absolutePath);
    // Round 5: hashed FROM THE OPEN FD (createReadStream on an fd, not a path)
    // so the hashed object IS the pinned object.
    expect(createReadStreamSpy).toHaveBeenCalledWith('', expect.objectContaining({ autoClose: false }));
    // The fd stays pinned on the instance (closed by engine.close()).
    expect((engine as unknown as { resolvedRootfsHandle?: { fd: number } }).resolvedRootfsHandle?.fd).toBeTypeOf('number');
    await engine.close();
  });

  it('matches the expected digest for a multi-chunk rootfs', async () => {
    // 256 KiB of deterministic data — large enough to exercise stream chunks.
    const content = Buffer.alloc(256 * 1024);
    for (let i = 0; i < content.length; i++) content[i] = i % 256;
    const { dir, ref } = await tempRootfs(content);
    const harness = await makeStartHarness([ref]);

    const engine = await makeResolveEngine(harness, path.join(dir, 'gate.json'), dir);
    const artifact = await engine.resolveRootfs(ref);
    expect(artifact.ref).toBe(ref);
    expect(artifact.size).toBe(content.length);
    await engine.close();
  });

  it('fails closed when probe() never succeeded (no cached verified state)', async () => {
    const { dir, ref } = await tempRootfs(Buffer.from('x'));
    const harness = await makeStartHarness([ref]);
    const engine = new VmEngineImpl(
      {
        helperPath: harness.helperPath,
        artifactsDir: harness.artifactsDir,
        tcbManifestPath: path.join(harness.dir, 'vm-tcb-manifest.json'),
        gateManifestPath: path.join(dir, 'gate.json'),
        rootfsDir: dir,
      },
      {
        platform: 'darwin-arm64',
        pipe: () => [10, 11] as [number, number],
        dupFdCloexec: distinctDups(),
        spawn: () => ({}) as unknown as VmInstanceRaw,
      } as unknown as VmEngineDeps,
    );
    // Deliberately NOT seeded — resolveRootfs must refuse without probe state.
    await expect(engine.resolveRootfs(ref)).rejects.toThrow(/probe\(\) must succeed/);
  });
});

// R5 (review round 5): probe() is the ONLY point that reads + verifies the
// gate manifest (and binds the release signature to it), and it binds the
// VERIFIED OBJECT to the USED OBJECT: the four TCB artifacts are copied into
// an engine-private 0700 dir (only those copies are ever executed/loaded) and
// the rootfs fd is pinned at resolveRootfs() (start() inherits it and the
// launch spec references /dev/fd/5). A file swapped after probe() is therefore
// NEUTRALIZED — the verified copy/pinned inode is what runs — while a swap
// BEFORE the binding point still fails closed on the from-fd digest check.
describe('VmEngineImpl post-probe object binding (R5)', () => {
  function minimalDeps(recorded?: { argv?: string[]; fileActions?: FileAction[] }): VmEngineDeps {
    const crs = new PassThrough();
    return makeDeps(
      {
        pipe: () => [10, 11],
        dupFdCloexec: distinctDups(),
        spawn: (_h, argv, _e, fileActions, _s, _p, c) => {
          if (recorded) { recorded.argv = argv; recorded.fileActions = fileActions; }
          return makeFakeChild(['{"ready":true}\n'], c);
        },
      },
      crs,
    );
  }

  beforeEach(() => {
    vi.clearAllMocks();
    vi.mocked(gateManifest.isRootfsQualified).mockImplementation(
      (m, ref) => m.qualifiedRootfsDigests.includes(ref),
    );
  });

  it('start() fails closed when probe() never succeeded', async () => {
    const harness = await makeStartHarness();
    const engine = new VmEngineImpl(
      {
        helperPath: harness.helperPath,
        artifactsDir: harness.artifactsDir,
        tcbManifestPath: path.join(harness.dir, 'vm-tcb-manifest.json'),
        gateManifestPath: path.join(harness.dir, 'gate-manifest.json'),
        rootfsDir: harness.dir,
      },
      minimalDeps(),
    );
    // Deliberately NOT seeded.
    await expect(engine.start(baseConfig(harness.rootfsArtifact) as any)).rejects.toThrow(/probe\(\) must succeed/);
  });

  it('a gate manifest swapped after probe() is INVISIBLE: only the cached gate qualifies refs', async () => {
    const { engine, harness } = await makeStartEngine(minimalDeps());
    // Attacker's self-consistent but UNSIGNED gate qualifying an evil ref,
    // written over the on-disk file AFTER probe() (the seed).
    const evilRef = 'sha256:' + '7'.repeat(64);
    const swappedGate = { ...harness.gate, qualifiedRootfsDigests: [evilRef] };
    await fsPromises.writeFile(path.join(harness.dir, 'gate-manifest.json'), JSON.stringify(swappedGate));

    // The evil ref stays unqualified (cached gate consulted, not the file)…
    await expect(engine.resolveRootfs(evilRef)).rejects.toThrow(/not in qualifiedRootfsDigests/);
    // …and the probe-verified ref still resolves.
    const artifact = await engine.resolveRootfs(harness.rootfsRef);
    expect(artifact.ref).toBe(harness.rootfsRef);
    await engine.close();
  });

  // Simulate an attacker with host fs write access swapping a file post-probe:
  // the verified files are 0555/0444, so restore a write bit before rewriting.
  async function tamper(filePath: string, content: string, mode: number) {
    await fsPromises.chmod(filePath, mode | 0o200);
    await fsPromises.writeFile(filePath, content, { mode });
  }

  it('a helper swapped after probe() is NEUTRALIZED: start() execs the verified private copy', async () => {
    const recorded: { argv?: string[] } = {};
    const { engine, harness, priv } = await makeStartEngine(minimalDeps(recorded));
    await tamper(harness.helperPath, 'EVIL-HELPER', 0o555);
    // The swap does NOT fail start — it is irrelevant: the executed binary is
    // the engine-private copy of the verified bytes.
    const inst = await engine.start(baseConfig(harness.rootfsArtifact) as any);
    expect(recorded.argv![0]).toBe(priv.tcbPaths.helper);
    expect(await fsPromises.readFile(priv.tcbPaths.helper, 'utf8')).toBe('HELPER');
    await inst.close();
    await engine.close();
  });

  it('a libkrun swapped after probe() is NEUTRALIZED: the private copy + loader path are used', async () => {
    const recorded: { argv?: string[] } = {};
    const { engine, harness, priv } = await makeStartEngine(minimalDeps(recorded));
    await tamper(harness.libkrunPath, 'EVIL-LIBKRUN', 0o555);
    const inst = await engine.start(baseConfig(harness.rootfsArtifact) as any);
    // The private copy still carries the verified bytes…
    expect(sha256Hex(await fsPromises.readFile(priv.tcbPaths.libkrun))).toBe(
      harness.tcbManifest.artifacts.libkrun.sha256,
    );
    // …and the private dir IS the loader search path (both are under it).
    expect(priv.tcbPaths.libkrun.startsWith(priv.privateDir)).toBe(true);
    await inst.close();
    await engine.close();
  });

  it('an image-builder swapped after probe() is NEUTRALIZED: getVerifiedImageBuilderPath returns the private copy', async () => {
    const { engine, harness, priv } = await makeStartEngine(minimalDeps());
    await tamper(harness.imageBuilderPath, 'EVIL-BUILDER', 0o555);
    const builderPath = await engine.getVerifiedImageBuilderPath();
    expect(builderPath).toBe(priv.tcbPaths.imageBuilder);
    expect(sha256Hex(await fsPromises.readFile(builderPath))).toBe(
      harness.tcbManifest.artifacts.imageBuilder.sha256,
    );
    await engine.close();
  });

  it('a rootfs swapped after resolveRootfs is NEUTRALIZED: start() attaches the pinned inode via /dev/fd/5', async () => {
    const recorded: { argv?: string[]; fileActions?: FileAction[] } = {};
    const { engine, harness } = await makeStartEngine(minimalDeps(recorded));
    await tamper(harness.rootfsPath, 'EVIL-ROOTFS-BYTES', 0o444);
    // The swap does NOT fail start — the launch spec references the pinned fd,
    // and the fd (inherited at slot 5) still points at the verified inode.
    const inst = await engine.start(baseConfig(harness.rootfsArtifact) as any);
    const spec = JSON.parse(Buffer.from(recorded.argv![1], 'base64url').toString('utf8'));
    expect(spec.rootfsPath).toBe('/dev/fd/5');
    const to5 = (recorded.fileActions ?? []).find(
      (a): a is { kind: 'adddup2'; src: number; target: number } => a.kind === 'adddup2' && a.target === 5,
    );
    expect(to5, 'the pinned rootfs fd is inherited at slot 5').toBeDefined();
    await inst.close();
    await engine.close();
  });

  it('a rootfs swapped BEFORE resolveRootfs fails closed on the from-fd digest check', async () => {
    const harness = await makeStartHarness();
    const engine = new VmEngineImpl(
      {
        helperPath: harness.helperPath,
        artifactsDir: harness.artifactsDir,
        tcbManifestPath: path.join(harness.dir, 'vm-tcb-manifest.json'),
        gateManifestPath: path.join(harness.dir, 'gate-manifest.json'),
        rootfsDir: harness.dir,
      },
      minimalDeps(),
    );
    await harness.seed(engine);
    // Swap the bytes BEFORE the binding point: the from-fd hash no longer
    // matches the ref — fail closed.
    await tamper(harness.rootfsPath, 'EVIL-ROOTFS-BYTES', 0o444);
    await expect(engine.resolveRootfs(harness.rootfsRef)).rejects.toThrow(/byte digest mismatch/);
    await engine.close();
  });

  it('close() releases the pinned rootfs fd and the engine-private TCB dir', async () => {
    const { engine, harness, priv } = await makeStartEngine(minimalDeps());
    await engine.close();
    // The private dir is removed…
    await expect(fsPromises.stat(priv.privateDir)).rejects.toThrow();
    // …the pinned fd state is cleared…
    const e = engine as unknown as { resolvedRootfsHandle?: unknown; verifiedProbe?: unknown };
    expect(e.resolvedRootfsHandle).toBeUndefined();
    expect(e.verifiedProbe).toBeUndefined();
    // …and start() after close() fails closed (no verified state remains).
    await expect(engine.start(baseConfig(harness.rootfsArtifact) as any)).rejects.toThrow(/probe\(\) must succeed/);
  });

  it('start() succeeds when nothing changed post-probe (happy path sanity)', async () => {
    const recorded: { argv?: string[] } = {};
    const { engine, harness, priv } = await makeStartEngine(minimalDeps(recorded));
    const inst = await engine.start(baseConfig(harness.rootfsArtifact) as any);
    expect(inst.stdin).toBeDefined();
    expect(recorded.argv![0]).toBe(priv.tcbPaths.helper);
    await inst.close();
    await engine.close();
  });
});
