/**
 * Canonical SandboxProcess contract (Plan 5, Task 2).
 *
 * Asserts the backend-agnostic invariants every SandboxBackend must satisfy:
 *
 *   1. The sole completion promise is `SandboxProcess.exited` — there is no
 *      `wait()` method, no second launcher wrapper, and no alternate
 *      completion surface.
 *   2. `run()` never bypasses `spawn()` semantics. It is structurally:
 *        spawn → optional stdin.write → stdin.end → await exited → close.
 *   3. `stdin` is a real NodeJS.WritableStream (not a function, not a no-op
 *      shim); `stdout`/`stderr` are real ReadableStreams.
 *   4. `close()` is idempotent and awaited; it does NOT replace `exited`.
 *
 * All assertions run against a behavioral fake that records call order —
 * no real child_process, no real Docker daemon, no kernel. Backend-specific
 * process behavior (duplex on a persistent PID, cgroup-kill-once, container
 * destroy) lives in `docker-process.test.ts` / `os-process.test.ts`.
 */
import { describe, it, expect, expectTypeOf, vi } from 'vitest';
import { PassThrough } from 'node:stream';
import type {
  SandboxBackend,
  SandboxProcess,
  BackendRunResult,
  ExecSpec,
  SpawnSpec,
  ProxyCarrier,
  BackendPrepareOptions,
} from '../src/backend.js';
import type { IsolationLevel } from '../src/types.js';

// ---------------------------------------------------------------------------
// Behavioral fake: records every observable event in order.
// ---------------------------------------------------------------------------

function makeRunResult(): BackendRunResult {
  return {
    exitCode: 0,
    stdout: '',
    stderr: '',
    timedOut: false,
    meta: {
      isolationLevel: 'full' satisfies IsolationLevel,
      backend: 'docker',
      degraded: false,
      degradationReasons: [],
    },
  };
}

interface FakeBackend extends SandboxBackend {
  events: string[];
  /** Set by spawn() so tests can trigger the child's close. */
  finishChild: ((code: number) => void) | undefined;
  childStdin: PassThrough | undefined;
  spawnCalls: SpawnSpec[];
}

function makeFakeBackend(): FakeBackend {
  const events: string[] = [];
  const backend: FakeBackend = {
    events,
    finishChild: undefined,
    childStdin: undefined,
    spawnCalls: [],
    kind: 'docker',
    isolationLevel: 'full',
    probe: async () => true,
    prepareTopology: async (): Promise<ProxyCarrier> => ({
      kind: 'in-process',
      listenHost: '10.0.0.1',
      reachableHost: '10.0.0.1',
    }),
    prepare: async (_opts: BackendPrepareOptions) => {},
    spawn: async (spec: SpawnSpec): Promise<SandboxProcess> => {
      events.push('spawn');
      backend.spawnCalls.push(spec);
      const stdin = new PassThrough();
      const stdout = new PassThrough();
      const stderr = new PassThrough();
      backend.childStdin = stdin;
      // exited resolves when the test calls finishChild() — simulates the
      // child's 'close' event.
      const exited = new Promise<BackendRunResult>((resolve) => {
        backend.finishChild = (code: number) => {
          events.push('exited');
          const r = makeRunResult();
          r.exitCode = code;
          resolve(r);
        };
      });
      let closed = false;
      return {
        stdin,
        stdout,
        stderr,
        exited,
        kill: async () => {},
        close: async () => {
          if (closed) return;
          closed = true;
          events.push('close');
        },
      };
    },
    // Canonical run() shape — spawn → optional stdin write → stdin.end →
    // await exited → close. This is the contract every backend must satisfy;
    // the fake mirrors docker-backend.run() and os-backend.run() verbatim.
    run: async (spec: ExecSpec): Promise<BackendRunResult> => {
      events.push('run');
      const proc = await backend.spawn({ ...spec, stdin: 'pipe' });
      if (typeof spec.stdin === 'string' || spec.stdin instanceof Uint8Array) {
        events.push('stdin:write');
        proc.stdin.write(spec.stdin);
      }
      events.push('stdin:end');
      proc.stdin.end();
      try {
        return await proc.exited;
      } finally {
        await proc.close();
      }
    },
    cleanup: async () => {},
  };
  return backend;
}

// ---------------------------------------------------------------------------
// Contract: SandboxProcess shape
// ---------------------------------------------------------------------------

describe('SandboxProcess — canonical contract', () => {
  it('exposes stdin/stdout/stderr/exited; `exited` is the sole completion promise', async () => {
    const backend = makeFakeBackend();
    const proc = await backend.spawn({ command: ['/usr/bin/node', '--version'] });

    // Real Node streams, not shims.
    expect(proc.stdin).toBeInstanceOf(PassThrough);
    expect(proc.stdout).toBeInstanceOf(PassThrough);
    expect(proc.stderr).toBeInstanceOf(PassThrough);

    // exited is a Promise of BackendRunResult.
    expect(proc.exited).toBeInstanceOf(Promise);

    // The contract names NO wait() method. We assert the absence structurally
    // (any addition of wait() would show up in Object.keys).
    expect(Object.keys(proc).sort()).toEqual(
      ['close', 'exited', 'kill', 'stderr', 'stdin', 'stdout'].sort(),
    );
    expect('wait' in proc).toBe(false);

    backend.finishChild?.(0);
    const result = await proc.exited;
    expect(result.exitCode).toBe(0);
    await proc.close();
  });

  it('close() is idempotent and does not resolve exited on its own', async () => {
    const backend = makeFakeBackend();
    const proc = await backend.spawn({ command: ['/usr/bin/node'] });

    // exited is still pending after close() — close is NOT a completion signal.
    let exitedResolved = false;
    void proc.exited.then(() => { exitedResolved = true; });

    await proc.close();
    await proc.close(); // idempotent
    await new Promise((r) => setImmediate(r));
    expect(exitedResolved).toBe(false);

    // Only finishChild (the simulated 'close' event) resolves exited.
    backend.finishChild?.(0);
    await proc.exited;
    expect(exitedResolved).toBe(true);
    // close() ran exactly once even though we called it twice (idempotent).
    expect(backend.events.filter((e) => e === 'close')).toHaveLength(1);
  });
});

// ---------------------------------------------------------------------------
// Contract: run() is implemented as spawn → stdin → exited → close
// ---------------------------------------------------------------------------

describe('SandboxBackend.run — canonical spawn delegation', () => {
  it('delegates to spawn() and observes spawn → stdin.write → stdin.end → exited → close', async () => {
    const backend = makeFakeBackend();

    // Trigger the simulated child close after a microtask so we can observe order.
    const runPromise = backend.run({ command: ['/usr/bin/node'], stdin: 'payload\n' });
    // Wait for spawn + stdin writes to land.
    await new Promise((r) => setImmediate(r));
    backend.finishChild?.(0);
    const result = await runPromise;

    expect(result.exitCode).toBe(0);
    expect(backend.events).toEqual([
      'run',
      'spawn',
      'stdin:write',
      'stdin:end',
      'exited',
      'close',
    ]);
  });

  it('run() forwards spec fields to spawn() and forces stdin:\'pipe\'', async () => {
    const backend = makeFakeBackend();
    const runPromise = backend.run({
      command: ['/usr/bin/node', '-e', 'process.exit(0)'],
      env: { FOO: 'bar' },
      timeoutMs: 1234,
      outputMaxBytes: 4096,
      stdin: 'x',
    });
    await new Promise((r) => setImmediate(r));
    backend.finishChild?.(0);
    await runPromise;

    expect(backend.spawnCalls).toHaveLength(1);
    const spec = backend.spawnCalls[0]!;
    expect(spec.command).toEqual(['/usr/bin/node', '-e', 'process.exit(0)']);
    expect(spec.env).toEqual({ FOO: 'bar' });
    expect(spec.timeoutMs).toBe(1234);
    expect(spec.outputMaxBytes).toBe(4096);
    // Spawn-side stdin is always the literal 'pipe' marker.
    expect(spec.stdin).toBe('pipe');
  });

  it('run() closes the process even when exited rejects', async () => {
    const backend = makeFakeBackend();
    // Override spawn to return a process whose exited rejects.
    const origSpawn = backend.spawn.bind(backend);
    backend.spawn = async (spec: SpawnSpec) => {
      const p = await origSpawn(spec);
      return {
        ...p,
        exited: Promise.reject(new Error('child crashed')),
      };
    };

    await expect(backend.run({ command: ['/usr/bin/node'] })).rejects.toThrow(/crashed/);
    // close() still ran (finally block).
    expect(backend.events).toContain('close');
  });

  it('run() never bypasses spawn — both share resource enforcement surface', async () => {
    const backend = makeFakeBackend();
    const spawnSpy = vi.spyOn(backend, 'spawn');
    const runPromise = backend.run({ command: ['/usr/bin/node'] });
    await new Promise((r) => setImmediate(r));
    backend.finishChild?.(0);
    await runPromise;
    expect(spawnSpy).toHaveBeenCalledTimes(1);
  });
});

// ---------------------------------------------------------------------------
// Type-level contract — the brief's exact assertions.
// ---------------------------------------------------------------------------

describe('SandboxBackend type-level contract', () => {
  it('spawn is a function and stdin is a NodeJS.WritableStream', () => {
    expectTypeOf<SandboxBackend['spawn']>().toBeFunction();
    expectTypeOf<SandboxProcess['stdin']>().toMatchTypeOf<NodeJS.WritableStream>();
    expectTypeOf<SandboxProcess['exited']>().toMatchTypeOf<Promise<BackendRunResult>>();
    // exited is readonly and there is no wait() method on the type.
    expectTypeOf<SandboxProcess>().not.toHaveProperty('wait');
  });
});
