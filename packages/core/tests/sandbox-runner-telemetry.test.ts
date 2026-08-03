/**
 * SandboxRunner telemetry tests (T3.3).
 *
 * Asserts the runner emits SandboxCompletedEvent through an optional injected
 * TelemetrySink, WITHOUT changing any existing behavior:
 *   - run() emits exactly ONE sandbox.completed AFTER the output is computed,
 *     carrying the FINAL (possibly containment-downgraded) meta, the derived
 *     exitCode (result.exitCode on success, null on error), and
 *     sandboxSuccess === output.success. The executionId comes from the
 *     injected ExecutionContext when present.
 *   - spawn() emits a CREATED sandbox.completed immediately after
 *     backend.spawn() succeeds (initial meta, exitCode:null, sandboxSuccess:false)
 *     with a FRESH executionId, then a FINAL sandbox.completed after close()
 *     resolves resultMeta, reusing the SAME executionId, with the FINAL
 *     downgraded meta and sandboxSuccess === !containment.
 *   - A throwing sink NEVER breaks run/spawn/close (fire-and-forget).
 *   - When no telemetrySink is injected, behavior is identical to today.
 */
import { describe, it, expect, beforeEach } from 'vitest';
import { PassThrough } from 'node:stream';
import type {
  BackendRunResult,
  ExecSpec,
  ProxyCarrier,
  ProxyHandle,
  ProxyLauncher,
  SandboxBackend,
  SandboxConfig,
  SandboxPolicy,
  SandboxProcess,
  SpawnSpec,
  ResolvedSecrets,
  BackendKind,
  IsolationLevel,
} from '@agentoctopus/sandbox';
import { ContainmentCleanupError } from '@agentoctopus/sandbox';
import { SandboxRunner } from '../src/sandbox-runner.js';
import type { ExecutionContext, TelemetryEvent, TelemetrySink } from '../src/execution-context.js';
import {
  RecordingSecretProvider,
  makeSkillFixture,
  makeSnapshotStore,
  makeTrustedConfig,
} from './sandbox-runner.test.js';

// ---------------------------------------------------------------------------
// Fakes
// ---------------------------------------------------------------------------

const FULL_META = {
  isolationLevel: 'full' as const,
  backend: 'docker' as const,
  degraded: false,
  degradationReasons: [] as string[],
};

class TelemetryBackend implements SandboxBackend {
  runResult: BackendRunResult = {
    exitCode: 0,
    stdout: 'ok',
    stderr: '',
    timedOut: false,
    meta: FULL_META,
  };
  cleanupError: ContainmentCleanupError | Error | undefined;
  runError: Error | undefined;

  constructor(
    public readonly kind: BackendKind,
    public readonly isolationLevel: IsolationLevel,
  ) {}

  async probe(): Promise<boolean> { return true; }
  async prepareTopology(): Promise<ProxyCarrier> {
    return { kind: 'in-process', listenHost: '10.0.0.1', reachableHost: '10.0.0.1' };
  }
  async prepare(): Promise<void> {}
  async run(_spec: ExecSpec): Promise<BackendRunResult> {
    if (this.runError) throw this.runError;
    return this.runResult;
  }
  async spawn(_spec: SpawnSpec): Promise<SandboxProcess> {
    const stdin = new PassThrough();
    const stdout = new PassThrough();
    const stderr = new PassThrough();
    const exited = Promise.resolve<BackendRunResult>(this.runResult);
    return {
      stdin,
      stdout,
      stderr,
      exited,
      kill: async () => {},
      close: async () => {},
    };
  }
  async cleanup(): Promise<void> {
    if (this.cleanupError) throw this.cleanupError;
  }
}

class TelemetryProxyLauncher implements ProxyLauncher {
  reachableAddr = 'http://10.0.0.1:8888';
  caBundlePath = '/tmp/host-ca/ca.pem';
  async launch(
    _opts: { policy: SandboxPolicy; secrets: ResolvedSecrets; workDir: string },
    _carrier: ProxyCarrier,
  ): Promise<ProxyHandle> {
    return {
      reachableAddr: this.reachableAddr,
      caBundlePath: this.caBundlePath,
      close: async () => {},
    };
  }
}

class CollectingSink implements TelemetrySink {
  readonly events: TelemetryEvent[] = [];
  emit(event: TelemetryEvent): void {
    this.events.push(event);
  }
}

class ThrowingSink implements TelemetrySink {
  emit(): void {
    throw new Error('sink exploded');
  }
}

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

describe('SandboxRunner — telemetry emission (T3.3)', () => {
  let storeDir: string;
  let config: SandboxConfig;

  beforeEach(() => {
    storeDir = makeSnapshotStore();
    config = makeTrustedConfig();
  });

  function makeRunner(opts: {
    backend: TelemetryBackend;
    telemetrySink?: TelemetrySink;
    execContext?: ExecutionContext;
  }): SandboxRunner {
    return new SandboxRunner({
      config,
      snapshotStoreDir: storeDir,
      backends: [opts.backend],
      proxyLauncher: new TelemetryProxyLauncher(),
      secretProvider: new RecordingSecretProvider(),
      installationIdFor: () => 'inst-1',
      telemetrySink: opts.telemetrySink,
      execContext: opts.execContext,
    });
  }

  it('run() emits exactly one sandbox.completed with final meta on clean success', async () => {
    const backend = new TelemetryBackend('docker', 'full');
    const sink = new CollectingSink();
    const runner = makeRunner({
      backend,
      telemetrySink: sink,
      execContext: { traceId: 'oct-e2e-abc', executionId: 'exec-1' },
    });
    const { skill } = makeSkillFixture();
    const out = await runner.run({ skill, command: ['node', '/skill/x.js'] });
    expect(out.success).toBe(true);

    const completed = sink.events.filter((e) => e.kind === 'sandbox.completed');
    expect(completed).toHaveLength(1);
    const ev = completed[0]!;
    if (ev.kind !== 'sandbox.completed') throw new Error('unreachable');
    expect(ev.traceId).toBe('oct-e2e-abc');
    expect(ev.executionId).toBe('exec-1');
    expect(ev.meta).toEqual(out.meta);
    expect(ev.exitCode).toBe(0);
    expect(ev.sandboxSuccess).toBe(true);
    expect(ev.phase).toBe('final');
  });

  it('run() emits sandbox.completed with downgraded meta when cleanup throws ContainmentCleanupError', async () => {
    const backend = new TelemetryBackend('docker', 'full');
    backend.cleanupError = new ContainmentCleanupError(['cgroup kill failed']);
    const sink = new CollectingSink();
    const runner = makeRunner({
      backend,
      telemetrySink: sink,
      execContext: { traceId: 'oct-e2e-def', executionId: 'exec-1' },
    });
    const { skill } = makeSkillFixture();
    const out = await runner.run({ skill, command: ['node', '/skill/x.js'] });
    expect(out.success).toBe(false);

    const completed = sink.events.filter((e) => e.kind === 'sandbox.completed');
    expect(completed).toHaveLength(1);
    const ev = completed[0]!;
    if (ev.kind !== 'sandbox.completed') throw new Error('unreachable');
    expect(ev.meta.isolationLevel).toBe('none');
    expect(ev.meta.degraded).toBe(true);
    expect(ev.meta.degradationReasons).toContain('cgroup kill failed');
    expect(ev.sandboxSuccess).toBe(false);
    expect(ev.exitCode).toBe(0);
    expect(ev.phase).toBe('final');
  });

  it('run() emits sandbox.completed with exitCode null on the error path', async () => {
    const backend = new TelemetryBackend('docker', 'full');
    backend.runError = new Error('exec exploded');
    const sink = new CollectingSink();
    const runner = makeRunner({
      backend,
      telemetrySink: sink,
      execContext: { traceId: 'oct-e2e-ghi', executionId: 'exec-1' },
    });
    const { skill } = makeSkillFixture();
    const out = await runner.run({ skill, command: ['node', '/skill/x.js'] });
    expect(out.success).toBe(false);

    const completed = sink.events.filter((e) => e.kind === 'sandbox.completed');
    expect(completed).toHaveLength(1);
    const ev = completed[0]!;
    if (ev.kind !== 'sandbox.completed') throw new Error('unreachable');
    expect(ev.exitCode).toBeNull();
    expect(ev.sandboxSuccess).toBe(false);
    expect(ev.phase).toBe('final');
  });

  it('run() generates a fresh executionId when the context omits one', async () => {
    const backend = new TelemetryBackend('docker', 'full');
    const sink = new CollectingSink();
    const runner = makeRunner({
      backend,
      telemetrySink: sink,
      execContext: { traceId: 'oct-e2e-noid' },
    });
    const { skill } = makeSkillFixture();
    await runner.run({ skill, command: ['node', '/skill/x.js'] });
    const completed = sink.events.filter((e) => e.kind === 'sandbox.completed');
    expect(completed).toHaveLength(1);
    const ev = completed[0]!;
    if (ev.kind !== 'sandbox.completed') throw new Error('unreachable');
    expect(typeof ev.executionId).toBe('string');
    expect(ev.executionId.length).toBeGreaterThan(0);
    expect(ev.traceId).toBe('oct-e2e-noid');
  });

  it('spawn() emits a created event then a final event sharing the same executionId', async () => {
    const backend = new TelemetryBackend('docker', 'full');
    const sink = new CollectingSink();
    const runner = makeRunner({
      backend,
      telemetrySink: sink,
      execContext: { traceId: 'oct-e2e-spawn' },
    });
    const { skill } = makeSkillFixture();
    const s = await runner.spawn({ skill, command: ['node', '/skill/x.js'] });

    // Created event already emitted after backend.spawn() succeeded.
    let completed = sink.events.filter((e) => e.kind === 'sandbox.completed');
    expect(completed).toHaveLength(1);
    const created = completed[0]!;
    if (created.kind !== 'sandbox.completed') throw new Error('unreachable');
    expect(created.meta).toEqual({
      isolationLevel: 'full',
      backend: 'docker',
      degraded: false,
      degradationReasons: [],
    });
    expect(created.exitCode).toBeNull();
    expect(created.sandboxSuccess).toBe(false);
    expect(created.phase).toBe('created');
    expect(typeof created.executionId).toBe('string');
    expect(created.executionId.length).toBeGreaterThan(0);

    await s.close();

    completed = sink.events.filter((e) => e.kind === 'sandbox.completed');
    expect(completed).toHaveLength(2);
    const final = completed[1]!;
    if (final.kind !== 'sandbox.completed') throw new Error('unreachable');
    expect(final.executionId).toBe(created.executionId);
    const meta = await s.resultMeta;
    expect(final.meta).toEqual(meta);
    expect(final.sandboxSuccess).toBe(true);
    expect(final.exitCode).toBeNull();
    expect(final.phase).toBe('final');
  });

  it('spawn() final event reflects containment downgrade when cleanup throws ContainmentCleanupError', async () => {
    const backend = new TelemetryBackend('docker', 'full');
    backend.cleanupError = new ContainmentCleanupError(['cgroup kill failed']);
    const sink = new CollectingSink();
    const runner = makeRunner({
      backend,
      telemetrySink: sink,
      execContext: { traceId: 'oct-e2e-spawn-down' },
    });
    const { skill } = makeSkillFixture();
    const s = await runner.spawn({ skill, command: ['node', '/skill/x.js'] });
    await expect(s.close()).rejects.toBeInstanceOf(ContainmentCleanupError);

    const completed = sink.events.filter((e) => e.kind === 'sandbox.completed');
    expect(completed).toHaveLength(2);
    const created = completed[0]!;
    const final = completed[1]!;
    if (created.kind !== 'sandbox.completed' || final.kind !== 'sandbox.completed') {
      throw new Error('unreachable');
    }
    expect(final.executionId).toBe(created.executionId);
    expect(final.meta.isolationLevel).toBe('none');
    expect(final.meta.degraded).toBe(true);
    expect(final.meta.degradationReasons).toContain('cgroup kill failed');
    expect(final.sandboxSuccess).toBe(false);
    expect(created.phase).toBe('created');
    expect(final.phase).toBe('final');
  });

  it('a throwing sink never breaks run()', async () => {
    const backend = new TelemetryBackend('docker', 'full');
    const runner = makeRunner({
      backend,
      telemetrySink: new ThrowingSink(),
      execContext: { executionId: 'exec-1' },
    });
    const { skill } = makeSkillFixture();
    const out = await runner.run({ skill, command: ['node', '/skill/x.js'] });
    expect(out.success).toBe(true);
  });

  it('a throwing sink never breaks spawn() or close()', async () => {
    const backend = new TelemetryBackend('docker', 'full');
    const runner = makeRunner({
      backend,
      telemetrySink: new ThrowingSink(),
    });
    const { skill } = makeSkillFixture();
    const s = await runner.spawn({ skill, command: ['node', '/skill/x.js'] });
    await expect(s.close()).resolves.toBeUndefined();
    const meta = await s.resultMeta;
    expect(meta.isolationLevel).toBe('full');
  });

  it('no telemetrySink injected: run/spawn/close behave identically to today', async () => {
    const backend = new TelemetryBackend('docker', 'full');
    const runner = makeRunner({ backend });
    const { skill } = makeSkillFixture();
    const out = await runner.run({ skill, command: ['node', '/skill/x.js'] });
    expect(out.success).toBe(true);
    const s = await runner.spawn({ skill, command: ['node', '/skill/x.js'] });
    await s.close();
    const meta = await s.resultMeta;
    expect(meta.isolationLevel).toBe('full');
  });
});
