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
//   - bootstrapArgv asserted [bootstrapPath, launchSpecBlob], length===2.
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

function baseConfig() {
  return {
    rootfsArtifact: { ref: 'sha256:' + 'a'.repeat(64), absolutePath: '/fake/rootfs.img', manifestDigest: 'sha256:' + 'b'.repeat(64), size: 1, mode: 0o444 },
    skillBlockImage: { ref: 'sha256:' + 'c'.repeat(64), absolutePath: '/fake/skill.img', manifestDigest: 'sha256:' + 'd'.repeat(64), size: 1, mode: 0o444 },
    caBlockImage: { ref: 'sha256:' + 'e'.repeat(64), absolutePath: '/fake/ca.img', manifestDigest: 'sha256:' + 'f'.repeat(64), size: 1, mode: 0o444 },
    bootstrapPath: '/usr/libexec/octopus-vm-init',
    bootstrapArgv: ['/usr/libexec/octopus-vm-init', 'PAYLOAD_BLOB'],
    vsockPort: 1234,
    vsockHostSocket: '/tmp/vsock.sock',
    memMib: 512,
    cpus: 2,
    readyTimeoutMs: 50,
    libkrunAbi: 'v1.19.4' as const,
  };
}

describe('VmEngineImpl.start FD plumbing (R9/R10, L1 fake-spawn seam)', () => {
  beforeEach(() => _resetExecCacheForTest());

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
    const engine = new VmEngineImpl({ helperPath: '/fake/helper', artifactsDir: '/fake' }, deps);
    const inst = await engine.start(baseConfig() as any);

    expect(recorded).toBeDefined();
    // Helper argv contract: [helperPath, helperSpecToken], length===2.
    // The nested bootstrapArgv is inside the base64url(JSON) spec at argv[1].
    expect(recorded.argv[0]).toBe('/fake/helper');
    expect(recorded.argv.length).toBe(2);
    expect(typeof recorded.argv[1]).toBe('string');
    const spec = JSON.parse(Buffer.from(recorded.argv[1], 'base64url').toString('utf8'));
    expect(spec.helperPath).toBeUndefined();
    expect(spec.bootstrapPath).toBe('/usr/libexec/octopus-vm-init');
    expect(spec.bootstrapArgv).toEqual(['/usr/libexec/octopus-vm-init', 'PAYLOAD_BLOB']);
    expect(spec.rootfsPath).toBe('/fake/rootfs.img');
    expect(spec.skillBlockPath).toBe('/fake/skill.img');
    expect(spec.caBlockPath).toBe('/fake/ca.img');
    expect(spec.vsockPort).toBe(1234);
    expect(spec.vsockHostSocket).toBe('/tmp/vsock.sock');
    expect(spec.memMib).toBe(512);
    expect(spec.cpus).toBe(2);
    expect(spec.trustedEnv).toEqual([]);

    const dup2s = recorded.fileActions.filter((a) => a.kind === 'adddup2') as { src: number; target: number; kind: 'adddup2' }[];
    // Exactly two adddup2: temp→3 (H2G read), temp→4 (G2H write).
    expect(dup2s.length).toBe(2);
    const to3 = dup2s.find((d) => d.target === 3);
    const to4 = dup2s.find((d) => d.target === 4);
    expect(to3, 'an adddup2 into fd 3 (H2G_READ)').toBeDefined();
    expect(to4, 'an adddup2 into fd 4 (G2H_WRITE)').toBeDefined();
    // R10 P1-2: source must be the F_DUPFD_CLOEXEC temp (≥10), NOT the raw 3/4.
    expect(to3!.src).toBeGreaterThanOrEqual(10);
    expect(to4!.src).toBeGreaterThanOrEqual(10);
    expect(to3!.src).not.toBe(3);
    expect(to4!.src).not.toBe(4);

    // Darwin: POSIX_SPAWN_CLOEXEC_DEFAULT attr set.
    expect(recorded.spawnAttrFlags).toContain('POSIX_SPAWN_CLOEXEC_DEFAULT');

    // After spawn Node closes its own h2gRead (3) + g2hWrite (4) + temp slots.
    expect(recorded.parentCloseFds).toContain(H2G_READ_SRC);
    expect(recorded.parentCloseFds).toContain(G2H_WRITE_SRC);
    // Temp slots closed too.
    expect(recorded.parentCloseFds).toContain(to3!.src);
    expect(recorded.parentCloseFds).toContain(to4!.src);
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
  ): Promise<NodeJS.ProcessEnv> {
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
    const engine = new VmEngineImpl({ helperPath: '/fake/helper', artifactsDir: '/fake' }, deps);

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

      const inst = await engine.start(baseConfig() as any);
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
    return recordedEnv;
  }

  it('passes a minimal allowlisted env on darwin-arm64 (HI-1)', async () => {
    const env = await runEnvAllowlistScenario('darwin-arm64');

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
    expect(env.DYLD_LIBRARY_PATH).toBe('/test/dyld');
  });

  it('passes a minimal allowlisted env on linux-x64 (HI-1)', async () => {
    const env = await runEnvAllowlistScenario('linux-x64');

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
    expect(env.LD_LIBRARY_PATH).toBe('/test/ld');
  });

  it('rejects bootstrapArgv that violates the [path, blob] length===2 contract', async () => {
    const controlReadStream = new PassThrough();
    const binding: FakeBinding = {
      pipe: () => [10, 11],
      dupFdCloexec: distinctDups(),
      spawn: (_h, _a, _e, _f, _s, _p, crs) => makeFakeChild(['{"ready":true}\n'], crs),
    };
    const deps = makeDeps(binding, controlReadStream);
    const engine = new VmEngineImpl({ helperPath: '/fake/helper', artifactsDir: '/fake' }, deps);
    const cfg = baseConfig();
    cfg.bootstrapArgv = ['/usr/libexec/octopus-vm-init', 'a', 'b']; // length 3
    await expect(engine.start(cfg as any)).rejects.toThrow(/bootstrapArgv/);
  });

  it('rejects bootstrapArgv[0] !== bootstrapPath', async () => {
    const controlReadStream = new PassThrough();
    const binding: FakeBinding = {
      pipe: () => [10, 11],
      dupFdCloexec: distinctDups(),
      spawn: (_h, _a, _e, _f, _s, _p, crs) => makeFakeChild(['{"ready":true}\n'], crs),
    };
    const deps = makeDeps(binding, controlReadStream);
    const engine = new VmEngineImpl({ helperPath: '/fake/helper', artifactsDir: '/fake' }, deps);
    const cfg = baseConfig();
    cfg.bootstrapArgv = ['/usr/libexec/SOMETHING-ELSE', 'blob'];
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
    const engine = new VmEngineImpl({ helperPath: '/fake/helper', artifactsDir: '/fake' }, deps);
    await expect(engine.start(baseConfig() as any)).rejects.toThrow(/bad launch spec/);
  });

  it('fails start when helper exits before ready', async () => {
    const controlReadStream = new PassThrough();
    const binding: FakeBinding = {
      pipe: () => [10, 11],
      dupFdCloexec: distinctDups(),
      spawn: (_h, _a, _e, _f, _s, _p, crs) => makeFakeChild([], crs, { exitBeforeReady: true, exitCode: 1 }),
    };
    const deps = makeDeps(binding, controlReadStream);
    const engine = new VmEngineImpl({ helperPath: '/fake/helper', artifactsDir: '/fake' }, deps);
    await expect(engine.start(baseConfig() as any)).rejects.toThrow(/ready|exited|before/i);
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
    const engine = new VmEngineImpl({ helperPath: '/fake/helper', artifactsDir: '/fake' }, deps);
    await expect(engine.start(baseConfig() as any)).rejects.toThrow(/timed out|timeout/i);
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
    const engine = new VmEngineImpl({ helperPath: '/fake/helper', artifactsDir: '/fake' }, deps);
    const inst = await engine.start(baseConfig() as any);
    // Trigger a kill → exited resolves 137/timedOut.
    await inst.kill();
    const r = await inst.exited;
    expect(r.exitCode).toBe(137);
    expect(r.timedOut).toBe(true);
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
    const engine = new VmEngineImpl({ helperPath: '/fake/helper', artifactsDir: '/fake' }, deps);
    const cfg = { ...baseConfig(), readyTimeoutMs: 5000 };
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
    const engine = new VmEngineImpl({ helperPath: '/fake/helper', artifactsDir: '/fake' }, deps);
    const cfg = { ...baseConfig(), readyTimeoutMs: 5000 };
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
    const engine = new VmEngineImpl({ helperPath: '/fake/helper', artifactsDir: '/fake' }, deps);
    const cfg = { ...baseConfig(), readyTimeoutMs: 5000 };
    const inst = await engine.start(cfg as any);
    expect(inst.stdin).toBeDefined();
    await inst.close();
  });
});

describe('VmEngineImpl.probe() BLK feature check (HI-5)', () => {
  const sha = (c: string) => 'sha256:' + c.repeat(64);
  const hex = (c: string) => c.repeat(64);
  const helperPath = '/fake/helper';
  const artifactsDir = '/fake/artifacts';
  const rootfsDir = '/fake/rootfs';
  let tempDir: string;
  let tcbPath: string;
  let gatePath: string;

  function makeProbeEngine(opts: Partial<ConstructorParameters<typeof VmEngineImpl>[0]> = {}) {
    return new VmEngineImpl(
      {
        helperPath,
        artifactsDir,
        tcbManifestPath: tcbPath,
        gateManifestPath: gatePath,
        rootfsDir,
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
    vi.mocked(tcbManifest.verifyVmTcb).mockResolvedValue({
      helper: '/fake/helper',
      libkrun: '/fake/libkrun.dylib',
      libkrunfw: '/fake/libkrunfw.dylib',
      imageBuilder: '/fake/vm-image-builder',
    });
    tempDir = await fsPromises.mkdtemp(path.join(tmpdir(), 'oct-probe-'));
    tcbPath = path.join(tempDir, 'tcb.json');
    gatePath = path.join(tempDir, 'gate.json');
    await fsPromises.writeFile(
      tcbPath,
      JSON.stringify({
        schemaVersion: 1,
        artifacts: {
          libkrun: { sha256: hex('a'), size: 1, mode: 0o555 },
          libkrunfw: { sha256: hex('b'), size: 1, mode: 0o555 },
          helper: { sha256: hex('c'), size: 1, mode: 0o555 },
          imageBuilder: { sha256: hex('d'), size: 1, mode: 0o555 },
        },
      }),
    );
    await fsPromises.writeFile(gatePath, '{}');
  });

  afterEach(async () => {
    await fsPromises.rm(tempDir, { recursive: true, force: true }).catch(() => {});
  });

  it('returns available:false when BLK feature is absent', async () => {
    const gateBody = validGateBody();
    vi.mocked(gateManifest.GateManifestSchema.parse).mockReturnValue(gateBody);
    vi.mocked(gateManifest.verifyGateManifest).mockReturnValue({ ok: true, reasons: [] });
    const engine = makeProbeEngine();
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
    const engine = makeProbeEngine();
    vi.spyOn(engine as any, 'probeBlkFeature').mockResolvedValue(true);

    const r = await engine.probe();
    expect(r.available).toBe(true);
    expect(r.blkFeature).toBe('present');
    expect(r.gateManifest).toBe('verified');
    expect(r.releaseManifest).toBe('missing');
  });

  it('fails closed when the BLK probe itself throws', async () => {
    const gateBody = validGateBody();
    vi.mocked(gateManifest.GateManifestSchema.parse).mockReturnValue(gateBody);
    vi.mocked(gateManifest.verifyGateManifest).mockReturnValue({ ok: true, reasons: [] });
    const engine = makeProbeEngine();
    vi.spyOn(engine as any, 'probeBlkFeature').mockRejectedValue(new Error('exec ENOENT'));

    const r = await engine.probe();
    expect(r.available).toBe(false);
    expect(r.blkFeature).toBe('absent');
    expect(r.reason).toMatch(/BLK|probe/i);
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
    const engine = makeProbeEngine({ releaseManifestPath: releaseManifest, releaseManifestSignaturePath: releaseSig });
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
    const engine = makeProbeEngine({ releaseManifestPath: releaseManifest, releaseManifestSignaturePath: releaseSig });
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
    const engine = makeProbeEngine({ releaseManifestPath: releaseManifest, releaseManifestSignaturePath: releaseSig });
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
    const engine = makeProbeEngine();
    vi.spyOn(engine as any, 'probeBlkFeature').mockResolvedValue(true);

    const r = await engine.probe();
    expect(r.available).toBe(true);
    expect(r.releaseManifest).toBe('missing');
    expect(gateManifest.verifyOuterReleaseManifest).not.toHaveBeenCalled();
  });
});

describe('VmEngineImpl.resolveRootfs() streaming digest (LO-1)', () => {
  async function tempRootfs(content: Buffer) {
    const dir = await fsPromises.mkdtemp(path.join(tmpdir(), 'oct-rootfs-'));
    const ref = 'sha256:' + createHash('sha256').update(content).digest('hex');
    const absolutePath = path.join(dir, ref);
    await fsPromises.writeFile(absolutePath, content, { mode: 0o444 });
    return { dir, ref, absolutePath };
  }

  function makeResolveEngine(gatePath: string, rootfsDir: string) {
    return new VmEngineImpl(
      {
        helperPath: '/fake/helper',
        artifactsDir: '/fake/artifacts',
        tcbManifestPath: '/fake/tcb.json',
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
  }

  beforeEach(() => {
    vi.clearAllMocks();
  });

  it('hashes the rootfs with createReadStream instead of fs.readFile', async () => {
    const content = Buffer.from('hello streaming rootfs');
    const { dir, ref, absolutePath } = await tempRootfs(content);
    const gatePath = path.join(dir, 'gate.json');
    const gateBody = {
      platform: 'darwin-arm64' as const,
      schemaVersion: 1 as const,
      artifacts: {},
      qualifiedRootfsDigests: [ref],
      libkrunAbi: 'v1.19.4' as const,
      blkFeatureRequired: true as const,
      gates: { G1: 'GO' as const, G2: 'GO' as const },
      gateReasons: [] as string[],
      qualifiedAt: new Date().toISOString(),
      manifestDigest: 'sha256:' + '0'.repeat(64),
    };
    await fsPromises.writeFile(gatePath, JSON.stringify(gateBody));
    vi.mocked(gateManifest.GateManifestSchema.parse).mockReturnValue(gateBody);
    vi.mocked(gateManifest.isRootfsQualified).mockReturnValue(true);

    const createReadStreamSpy = fs.createReadStream;

    const engine = makeResolveEngine(gatePath, dir);
    const artifact = await engine.resolveRootfs(ref);

    expect(artifact.ref).toBe(ref);
    expect(artifact.absolutePath).toBe(absolutePath);
    expect(createReadStreamSpy).toHaveBeenCalledWith(absolutePath);

    await fsPromises.rm(dir, { recursive: true, force: true });
  });

  it('matches the expected digest for a multi-chunk rootfs', async () => {
    // 256 KiB of deterministic data — large enough to exercise stream chunks.
    const content = Buffer.alloc(256 * 1024);
    for (let i = 0; i < content.length; i++) content[i] = i % 256;
    const { dir, ref, absolutePath } = await tempRootfs(content);
    const gatePath = path.join(dir, 'gate.json');
    const gateBody = {
      platform: 'darwin-arm64' as const,
      schemaVersion: 1 as const,
      artifacts: {},
      qualifiedRootfsDigests: [ref],
      libkrunAbi: 'v1.19.4' as const,
      blkFeatureRequired: true as const,
      gates: { G1: 'GO' as const, G2: 'GO' as const },
      gateReasons: [] as string[],
      qualifiedAt: new Date().toISOString(),
      manifestDigest: 'sha256:' + '0'.repeat(64),
    };
    await fsPromises.writeFile(gatePath, JSON.stringify(gateBody));
    vi.mocked(gateManifest.GateManifestSchema.parse).mockReturnValue(gateBody);
    vi.mocked(gateManifest.isRootfsQualified).mockReturnValue(true);

    const engine = makeResolveEngine(gatePath, dir);
    const artifact = await engine.resolveRootfs(ref);
    expect(artifact.ref).toBe(ref);
    expect(artifact.size).toBe(content.length);

    await fsPromises.rm(dir, { recursive: true, force: true });
  });
});
