/**
 * Telemetry integration test — executionId sharing across adapter + sandbox.
 *
 * Regression for the bug where Executor and SandboxRunner emitted different
 * executionIds for the same logical execution (each fell back to its own
 * randomUUID() when the incoming ExecutionContext lacked an executionId). The
 * DebugTelemetryBuffer merges runs[] by executionId, so two separate entries
 * were created and the acceptance gate (which reads the FINAL runs[] element
 * expecting BOTH sandbox and adapter events) deterministically failed.
 *
 * This test exercises:
 *   REAL Executor + REAL SandboxRunner (stub backend) + REAL DebugTelemetryBuffer
 * and asserts that ONE execute() call with a traceId-bearing context produces
 * exactly ONE runs[] entry containing BOTH events with matching executionIds.
 */
import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { PassThrough } from 'node:stream';
import { mkdtempSync, mkdirSync, writeFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import {
  Executor,
  SandboxRunner,
  type SandboxBackend,
  type SandboxConfig,
  type SandboxPolicy,
  type ExecSpec,
  type BackendRunResult,
  type ProxyCarrier,
  type ProxyHandle,
  type ProxyLauncher,
  type SandboxProcess,
  type SpawnSpec,
  type ResolvedSecrets,
  type BackendKind,
  type IsolationLevel,
  type TelemetryEvent,
  type TelemetrySink,
  type ExecutionContext,
} from '@agentoctopus/core';
import type { LoadedSkill } from '@agentoctopus/registry';
import { DebugTelemetryBuffer } from '../src/debug-telemetry.js';

// ---------------------------------------------------------------------------
// Stub backend (full isolation, always succeeds)
// ---------------------------------------------------------------------------

const FULL_META = {
  isolationLevel: 'full' as const,
  backend: 'docker' as const,
  degraded: false,
  degradationReasons: [] as string[],
};

class StubBackend implements SandboxBackend {
  readonly kind: BackendKind = 'docker';
  readonly isolationLevel: IsolationLevel = 'full';
  async probe(): Promise<boolean> { return true; }
  async prepareTopology(): Promise<ProxyCarrier> {
    return { kind: 'in-process', listenHost: '10.0.0.1', reachableHost: '10.0.0.1' };
  }
  async prepare(): Promise<void> {}
  async run(_spec: ExecSpec): Promise<BackendRunResult> {
    return {
      exitCode: 0,
      stdout: 'Weather in Tokyo: 22 °C, partly cloudy',
      stderr: '',
      timedOut: false,
      meta: FULL_META,
    };
  }
  async spawn(_spec: SpawnSpec): Promise<SandboxProcess> {
    throw new Error('spawn not used in this test');
  }
  async cleanup(): Promise<void> {}
}

class StubProxyLauncher implements ProxyLauncher {
  async launch(
    _opts: { policy: SandboxPolicy; secrets: ResolvedSecrets; workDir: string },
    _carrier: ProxyCarrier,
  ): Promise<ProxyHandle> {
    return {
      reachableAddr: 'http://10.0.0.1:8888',
      caBundlePath: '/tmp/test-ca.pem',
      close: async () => {},
    };
  }
}

// ---------------------------------------------------------------------------
// Fixtures
// ---------------------------------------------------------------------------

const dirs: string[] = [];

function makeSkill(): LoadedSkill {
  const dirPath = mkdtempSync(join(tmpdir(), 'oct-integ-skill-'));
  dirs.push(dirPath);
  // SKILL.md is required for buildSnapshot
  writeFileSync(join(dirPath, 'SKILL.md'), '---\nname: weather\nadapter: subprocess\ndescription: test weather skill\n---\n# weather\n', 'utf8');
  mkdirSync(join(dirPath, 'scripts'), { recursive: true });
  writeFileSync(join(dirPath, 'scripts', 'invoke.js'), '// noop', 'utf8');
  return {
    dirPath,
    manifest: { name: 'weather', adapter: 'subprocess', description: 'test weather skill', credentials: [] },
  } as unknown as LoadedSkill;
}

function makeStore(): string {
  const d = mkdtempSync(join(tmpdir(), 'oct-integ-store-'));
  dirs.push(d);
  return d;
}

function makeConfig(): SandboxConfig {
  return {
    defaultBackend: 'docker',
    minIsolationLevel: 'full',
    runtimeProfiles: {
      bare: {
        bins: [],
        path: '/usr/bin:/bin',
        dockerImage:
          'busybox@sha256:bbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb',
      },
    },
    defaults: { memory: '512m', timeoutMs: 30_000, cpus: '0.5', outputMaxBytes: 1_048_576 },
    grants: [],
    docker: {
      image:
        'node@sha256:aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa',
      memory: '512m',
      cpus: '0.5',
      pids: 64,
      ulimits: { nofile: 256, fsize: '32m' },
    },
    proxy: {
      artifact:
        'proxy@sha256:cccccccccccccccccccccccccccccccccccccccccccccccccccccccccccccccc',
      maxReqBytes: 1_048_576,
      maxRespBytes: 10_485_760,
      maxConns: 32,
    },
  } as SandboxConfig;
}

function makeRegistry(): unknown {
  return {
    recordInvocation: () => {},
    recordInvocationMetrics: () => {},
    readInstructions: () => 'Weather skill: call wttr.in API',
  };
}

afterEach(() => {
  for (const d of dirs) {
    try { rmSync(d, { recursive: true, force: true }); } catch { /* best effort */ }
  }
  dirs.length = 0;
});

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

describe('executionId sharing across adapter + sandbox (regression)', () => {
  it('one execute() produces exactly one runs[] entry with BOTH sandbox and adapter events sharing the same executionId', async () => {
    const backend = new StubBackend();
    const storeDir = makeStore();
    const config = makeConfig();
    const skill = makeSkill();

    // Shared buffer and sink (mirrors engine.ts wiring)
    const telemetryBuffer = new DebugTelemetryBuffer(10);
    const telemetrySink: TelemetrySink = {
      emit: (e: TelemetryEvent) => telemetryBuffer.record(e, {}),
    };

    const runner = new SandboxRunner({
      config,
      snapshotStoreDir: storeDir,
      backends: [backend],
      proxyLauncher: new StubProxyLauncher(),
      secretProvider: { resolve: async () => undefined },
      installationIdFor: () => 'inst-integ-1',
      telemetrySink,
    });

    // Record request-start (mirrors /ask handler)
    const traceId = 'oct-e2e-integ-test-1';
    const execContext: ExecutionContext = { traceId, apiKeyId: 'user:test_user', receivedAt: Date.now() };
    telemetryBuffer.recordRequestStart(traceId, {
      apiKeyId: execContext.apiKeyId,
      receivedAt: execContext.receivedAt,
      queryHash: 'abc123',
    });

    // Create the Executor with the SAME runner and sink
    const executor = new Executor(
      makeRegistry() as any,
      undefined, // no chat client
      undefined, // no router
      runner,
      { telemetrySink },
    );

    // Drive one execute() with the traceId-bearing context
    const result = await executor.execute(skill, { query: 'weather in Tokyo' }, { execContext });
    expect('adapterResult' in result && result.adapterResult.success).toBe(true);

    // Emit the terminal event (mirrors /ask handler's finally block)
    telemetryBuffer.record(
      { kind: 'request.completed', traceId, reason: null },
      {},
    );

    // ── Assertions ────────────────────────────────────────────────────────
    const run = telemetryBuffer.getByRunId(traceId);
    expect(run).not.toBeNull();
    expect(run!.status).toBe('complete');

    // Exactly ONE runs[] entry (sandbox + adapter merged by shared executionId)
    expect(run!.runs).toHaveLength(1);

    const runsEntry = run!.runs[0]!;
    expect(runsEntry.status).toBe('final');

    // Both events present
    expect(runsEntry.sandbox).toBeDefined();
    expect(runsEntry.adapter).toBeDefined();

    // Same executionId on both events
    expect(runsEntry.sandbox!.executionId).toBe(runsEntry.executionId);
    expect(runsEntry.adapter!.executionId).toBe(runsEntry.executionId);

    // Sandbox event details
    expect(runsEntry.sandbox!.phase).toBe('final');
    expect(runsEntry.sandbox!.sandboxSuccess).toBe(true);
    expect(runsEntry.sandbox!.meta.isolationLevel).toBe('full');
    expect(runsEntry.sandbox!.meta.backend).toBe('docker');

    // Adapter event details
    expect(runsEntry.adapter!.adapterSuccess).toBe(true);

    // Routing event absent (we didn't go through router in this test)
    expect(run!.routing).toBeUndefined();

    // Terminal event
    expect(run!.terminal).toBeDefined();
    expect(run!.terminal!.kind).toBe('request.completed');
  });

  it('without traceId, no runs[] entry is created (non-E2E traffic ignored)', async () => {
    const backend = new StubBackend();
    const storeDir = makeStore();
    const config = makeConfig();
    const skill = makeSkill();

    const telemetryBuffer = new DebugTelemetryBuffer(10);
    const telemetrySink: TelemetrySink = {
      emit: (e: TelemetryEvent) => telemetryBuffer.record(e, {}),
    };

    const runner = new SandboxRunner({
      config,
      snapshotStoreDir: storeDir,
      backends: [backend],
      proxyLauncher: new StubProxyLauncher(),
      secretProvider: { resolve: async () => undefined },
      installationIdFor: () => 'inst-integ-2',
      telemetrySink,
    });

    const executor = new Executor(
      makeRegistry() as any,
      undefined,
      undefined,
      runner,
      { telemetrySink },
    );

    // No traceId → no E2E correlation
    await executor.execute(skill, { query: 'weather in Tokyo' });

    expect(telemetryBuffer.latest()).toBeNull();
  });

  it('per-skill output validators set outputValidated on the adapter event', async () => {
    const backend = new StubBackend();
    const storeDir = makeStore();
    const config = makeConfig();
    const skill = makeSkill();

    const telemetryBuffer = new DebugTelemetryBuffer(10);
    const telemetrySink: TelemetrySink = {
      emit: (e: TelemetryEvent) => telemetryBuffer.record(e, {}),
    };

    const runner = new SandboxRunner({
      config,
      snapshotStoreDir: storeDir,
      backends: [backend],
      proxyLauncher: new StubProxyLauncher(),
      secretProvider: { resolve: async () => undefined },
      installationIdFor: () => 'inst-integ-3',
      telemetrySink,
    });

    const traceId = 'oct-e2e-integ-validator';
    const execContext: ExecutionContext = { traceId, receivedAt: Date.now() };
    telemetryBuffer.recordRequestStart(traceId, { receivedAt: execContext.receivedAt });

    const weatherValidator = async (output: { success: boolean; rawText?: string }) => {
      if (!output.success) return { ok: false, reason: 'adapter failed' };
      if (/\d+\s*°\s*[CF]/i.test(output.rawText ?? '')) return { ok: true };
      return { ok: false, reason: 'no temperature pattern' };
    };

    const executor = new Executor(
      makeRegistry() as any,
      undefined,
      undefined,
      runner,
      { telemetrySink, outputValidators: { weather: weatherValidator } },
    );

    await executor.execute(skill, { query: 'weather in Tokyo' }, { execContext });
    telemetryBuffer.record({ kind: 'request.completed', traceId, reason: null }, {});

    const run = telemetryBuffer.getByRunId(traceId);
    expect(run!.runs).toHaveLength(1);
    expect(run!.runs[0]!.adapter!.outputValidated).toBe(true);
    expect(run!.runs[0]!.adapter!.outputValidationReason).toBeNull();
  });
});
