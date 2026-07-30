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
import { describe, it, expect, beforeEach } from 'vitest';
import { PassThrough } from 'node:stream';
import { VmEngineImpl, type VmEngineDeps } from '../src/engine.js';
import { _resetExecCacheForTest } from '../src/executables-qualified.js';

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
): VmEngineDeps {
  return {
    platform: 'darwin-arm64',
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
});
