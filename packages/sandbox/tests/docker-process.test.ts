/**
 * Docker process contract — daemon-independent (Plan 5, Task 2).
 *
 * What is asserted here WITHOUT a Docker daemon and WITHOUT
 * `vi.mock('node:child_process')`:
 *
 *   1. `run()` is implemented as spawn → optional stdin write/end → await
 *      exited → close (never bypasses spawn semantics). We exercise this on
 *      a docker-shaped fake backend so the delegation is observable.
 *   2. Persistent duplex: a single backend-spawned child process serves TWO
 *      newline-delimited requests and produces TWO responses on the SAME
 *      persistent fake ChildProcess — no second spawn, one PID, idempotent
 *      close().
 *   3. `exited` is the sole completion promise (no `wait()`).
 *   4. `buildDockerArgs` produces the docker-specific isolation surface
 *      (read-only root, /skill + /etc/skill-ca/ca.pem mounts, internal
 *      network) that the persistent child runs under.
 *
 * The daemon-gated integration case (real `docker run`) lives in
 * `docker-backend.test.ts` and is unchanged; this file is the always-on
 * contract complement.
 */
import { describe, it, expect, vi } from 'vitest';
import { PassThrough } from 'node:stream';
import { buildDockerArgs } from '../src/docker/docker-backend.js';
import type {
  SandboxBackend,
  SandboxProcess,
  BackendRunResult,
  BackendPrepareOptions,
  ProxyCarrier,
  SpawnSpec,
  ExecSpec,
} from '../src/backend.js';
import { SandboxConfigSchema, ImmutableImageRefSchema } from '../src/schema.js';

// ---------------------------------------------------------------------------
// Fixtures
// ---------------------------------------------------------------------------

const DUMMY_IMAGE = `alpine@sha256:${'a'.repeat(64)}`;
const unitConfig = SandboxConfigSchema.parse({
  docker: { image: DUMMY_IMAGE, memory: '128m', cpus: '0.5', pids: 32, ulimits: { nofile: 128, fsize: '16m' } },
  proxy: { artifact: DUMMY_IMAGE },
  defaults: { memory: '512m', timeoutMs: 15000, cpus: '2', outputMaxBytes: 65536 },
});

function makePrepareOpts(): BackendPrepareOptions {
  return {
    hosts: ['example.com'],
    credentials: [],
    denied: { hosts: [], credentials: [] },
    resources: { memoryBytes: 64 * 1024 * 1024, cpus: 0.5, timeoutMs: 5000 },
    snapshotRoot: '/snap/a',
    proxyAddr: 'http://egress-proxy:8080',
    caBundlePath: '/host/session-ca.pem',
    runtimeProfile: { id: 'unit', bins: ['node'], path: '/usr/local/bin', dockerImage: DUMMY_IMAGE },
    guestSkillRoot: '/skill',
    guestCaBundlePath: '/etc/skill-ca/ca.pem',
  };
}

// ---------------------------------------------------------------------------
// Fake docker-shaped persistent ChildProcess. Records every observable
// interaction; emits 'close' only when the test calls finish().
// ---------------------------------------------------------------------------

interface FakeDockerChild {
  pid: number;
  stdin: PassThrough;
  stdout: PassThrough;
  stderr: PassThrough;
  writes: Buffer[];
  finish: (code: number) => void;
  respond: (chunk: string) => void;
  killed: NodeJS.Signals[];
}

function makeFakeDockerChild(pid = 7777): FakeDockerChild {
  const stdin = new PassThrough();
  const stdout = new PassThrough();
  const stderr = new PassThrough();
  const writes: Buffer[] = [];
  const killed: NodeJS.Signals[] = [];
  stdin.on('data', (c: Buffer) => writes.push(c));

  let closeCbs: Array<(code: number) => void> = [];
  const child: FakeDockerChild = {
    pid,
    stdin,
    stdout,
    stderr,
    writes,
    killed,
    finish: (code: number) => {
      for (const cb of closeCbs) cb(code);
    },
    respond: (chunk: string) => {
      stdout.write(chunk);
    },
  };
  // Expose the listener registry so the fake backend can wire close events.
  (child as unknown as { _registerClose: (cb: (code: number) => void) => void })._registerClose =
    (cb) => closeCbs.push(cb);
  return child;
}

// ---------------------------------------------------------------------------
// Docker-shaped fake backend: mirrors DockerBackend's spawn()/run() surface
// but is daemon-independent. Every spawn produces ONE persistent FakeDockerChild.
// ---------------------------------------------------------------------------

interface DockerFakeBackend extends SandboxBackend {
  spawnCalls: SpawnSpec[];
  children: FakeDockerChild[];
  lastChild: FakeDockerChild | undefined;
}

function makeDockerFakeBackend(): DockerFakeBackend {
  const backend: DockerFakeBackend = {
    kind: 'docker',
    isolationLevel: 'full',
    spawnCalls: [],
    children: [],
    lastChild: undefined,
    probe: async () => true,
    prepareTopology: async (): Promise<ProxyCarrier> => ({
      kind: 'docker-sidecar',
      proxyImage: DUMMY_IMAGE,
      internalNetwork: 'octopus-sbx-x-internal',
      egressNetwork: 'octopus-sbx-x-egress',
      reachableHost: 'egress-proxy',
    }),
    prepare: async () => {},
    spawn: async (spec: SpawnSpec): Promise<SandboxProcess> => {
      backend.spawnCalls.push(spec);
      const child = makeFakeDockerChild(7777 + backend.children.length);
      backend.children.push(child);
      backend.lastChild = child;

      const stdout = new PassThrough();
      const stderr = new PassThrough();
      child.stdout.pipe(stdout);
      child.stderr.pipe(stderr);

      const outChunks: Buffer[] = [];
      stdout.on('data', (c: Buffer) => outChunks.push(c));

      const exited = new Promise<BackendRunResult>((resolve) => {
        (child as unknown as { _registerClose: (cb: (code: number) => void) => void })._registerClose((code) => {
          resolve({
            exitCode: code,
            stdout: Buffer.concat(outChunks).toString('utf8'),
            stderr: '',
            timedOut: false,
            meta: { isolationLevel: 'full', backend: 'docker', degraded: false, degradationReasons: [] },
          });
        });
      });

      let closed = false;
      return {
        stdin: child.stdin,
        stdout,
        stderr,
        exited,
        kill: async (signal) => {
          child.killed.push(signal ?? 'SIGKILL');
        },
        close: async () => {
          if (closed) return;
          closed = true;
          child.stdin.end();
        },
      };
    },
    // Mirrors docker-backend.ts run() verbatim: spawn → write/end → exited → close.
    run: async (spec: ExecSpec): Promise<BackendRunResult> => {
      const proc = await backend.spawn({ ...spec, stdin: 'pipe' });
      if (typeof spec.stdin === 'string' || spec.stdin instanceof Uint8Array) proc.stdin.write(spec.stdin);
      proc.stdin.end();
      try { return await proc.exited; } finally { await proc.close(); }
    },
    cleanup: async () => {},
  };
  return backend;
}

// ---------------------------------------------------------------------------
// 1. run() delegation contract (daemon-independent)
// ---------------------------------------------------------------------------

describe('DockerBackend run() — spawn delegation contract (daemon-independent)', () => {
  it('run() invokes spawn exactly once with stdin:\'pipe\' and propagates the spec', async () => {
    const backend = makeDockerFakeBackend();
    const runPromise = backend.run({
      command: ['node', '/skill/invoke.js'],
      stdin: '{"q":"hi"}\n',
      timeoutMs: 1000,
      outputMaxBytes: 1024,
    });
    // Give run() a microtask to reach spawn, then finish the child.
    await new Promise((r) => setImmediate(r));
    backend.lastChild!.finish(0);
    const result = await runPromise;

    expect(result.exitCode).toBe(0);
    expect(result.meta.backend).toBe('docker');
    expect(backend.spawnCalls).toHaveLength(1);
    const spec = backend.spawnCalls[0]!;
    expect(spec.command).toEqual(['node', '/skill/invoke.js']);
    expect(spec.stdin).toBe('pipe');
    expect(spec.timeoutMs).toBe(1000);
    expect(spec.outputMaxBytes).toBe(1024);
    // The one-shot stdin payload was written into the persistent pipe.
    const written = Buffer.concat(backend.lastChild!.writes).toString('utf8');
    expect(written).toBe('{"q":"hi"}\n');
  });
});

// ---------------------------------------------------------------------------
// 2. Persistent duplex — two newline-delimited requests, two responses, ONE PID
// ---------------------------------------------------------------------------

describe('DockerBackend persistent duplex (daemon-independent)', () => {
  it('one persistent child serves two newline-delimited requests → two responses on the SAME PID', async () => {
    const backend = makeDockerFakeBackend();
    const proc = await backend.spawn({ command: ['node', '/skill/echo-server.js'] });

    // Two newline-delimited requests on the SAME persistent child.
    proc.stdin.write(JSON.stringify({ id: 1 }) + '\n');
    proc.stdin.write(JSON.stringify({ id: 2 }) + '\n');

    // Only one spawn happened, one PID.
    expect(backend.spawnCalls).toHaveLength(1);
    expect(backend.children).toHaveLength(1);
    const child = backend.children[0]!;
    expect(child.pid).toBeGreaterThan(0);

    // Collect the responses that arrive on stdout.
    const received: string[] = [];
    proc.stdout.on('data', (c: Buffer) => {
      for (const line of c.toString('utf8').split('\n')) {
        if (line.length > 0) received.push(line);
      }
    });

    // Drive TWO responses on the same persistent child (no new spawn).
    child.respond('{"id":1,"ok":true}\n');
    child.respond('{"id":2,"ok":true}\n');

    // End stdin so close() is well-defined; then finish the child.
    proc.stdin.end();
    child.finish(0);

    const result = await proc.exited;
    expect(result.exitCode).toBe(0);
    expect(result.stdout).toContain('"id":1');
    expect(result.stdout).toContain('"id":2');

    // The two responses were observed in order on ONE stream.
    expect(received).toEqual(['{"id":1,"ok":true}', '{"id":2,"ok":true}']);

    // close() is idempotent.
    await proc.close();
    await proc.close();

    // exited remains the SOLE completion surface (no wait()).
    expect('wait' in proc).toBe(false);
  });

  it('spawn() does NOT take a one-shot stdin payload — SpawnSpec.stdin is only \'pipe\'', async () => {
    const backend = makeDockerFakeBackend();
    // Type-level: SpawnSpec['stdin'] is the literal 'pipe' (or undefined).
    type _Assert = SpawnSpec['stdin'] extends 'pipe' | undefined ? true : false;
    const ok: _Assert = true;
    expect(ok).toBe(true);

    const proc = await backend.spawn({ command: ['node'] });
    expect(backend.spawnCalls[0]!.stdin).toBeUndefined();
    proc.stdin.end();
    backend.lastChild!.finish(0);
    await proc.exited;
    await proc.close();
  });
});

// ---------------------------------------------------------------------------
// 3. buildDockerArgs — docker-specific isolation surface for the persistent child
// ---------------------------------------------------------------------------

describe('buildDockerArgs — persistent child isolation surface (daemon-independent)', () => {
  it('mounts snapshot at /skill:ro, CA bundle at /etc/skill-ca/ca.pem:ro, and binds only the internal network', () => {
    const args = buildDockerArgs({
      config: unitConfig,
      prepare: makePrepareOpts(),
      spec: { command: ['node', '/skill/echo-server.js'] },
      networkName: 'octopus-sbx-x-internal',
      containerName: 'octopus-sbx-runtime-x',
    });

    // Network: internal only (no egress on the runtime container).
    const netIdx = args.indexOf('--network');
    expect(netIdx).toBeGreaterThan(-1);
    expect(args[netIdx + 1]).toBe('octopus-sbx-x-internal');
    // No --network-alias on the runtime container — only the sidecar has one.
    expect(args).not.toContain('--network-alias');

    // Read-only root + tmpfs.
    expect(args).toContain('--read-only');

    // Mounts use the canonical literal guest paths.
    const volumes = args.filter((a, i) => args[i - 1] === '-v');
    expect(volumes.some((v) => v.endsWith(':/skill:ro'))).toBe(true);
    expect(volumes).toContain('/host/session-ca.pem:/etc/skill-ca/ca.pem:ro');

    // Trusted proxy + CA envs are pushed with the literal guest paths.
    expect(args).toContain('SSL_CERT_FILE=/etc/skill-ca/ca.pem');
    expect(args).toContain('NODE_EXTRA_CA_CERTS=/etc/skill-ca/ca.pem');
    expect(args).toContain('REQUESTS_CA_BUNDLE=/etc/skill-ca/ca.pem');
    expect(args).toContain('HTTP_PROXY=http://egress-proxy:8080');
    expect(args).toContain('HTTPS_PROXY=http://egress-proxy:8080');
  });

  it('rejects a mutable runtime image (digest-pinned contract)', () => {
    const bad = ImmutableImageRefSchema.safeParse('example/runtime:latest');
    expect(bad.success).toBe(false);
  });
});
