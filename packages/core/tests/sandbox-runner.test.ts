/**
 * SandboxRunner orchestration tests (Task 3).
 *
 * This file ALSO exports the shared recording-fake harness used by the other
 * three sandbox-runner test files (`-snapshot`, `-proxy`, `-runtime`). The
 * brief fixes the staging list to exactly these 4 test files, so the harness
 * lives here rather than in its own module.
 */
import { describe, it, expect, beforeEach } from 'vitest';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { PassThrough } from 'node:stream';
import type {
  BackendPrepareOptions,
  BackendRunResult,
  ExecSpec,
  InstallationIdentity,
  ProxyCarrier,
  ProxyHandle,
  ProxyLauncher,
  SandboxBackend,
  SandboxConfig,
  SandboxPolicy,
  SandboxProcess,
  SecretProvider,
  SpawnSpec,
  ResolvedSecrets,
  BackendKind,
  IsolationLevel,
} from '@agentoctopus/sandbox';
import type { LoadedSkill } from '@agentoctopus/registry';
import { SandboxRunner } from '../src/sandbox-runner.js';

// ---------------------------------------------------------------------------
// Recording-fake harness (shared)
// ---------------------------------------------------------------------------

export interface RunnerEvent {
  at: number;
  name: string;
  detail?: unknown;
}

export function makeEventLog(): {
  log: RunnerEvent[];
  record(name: string, detail?: unknown): void;
} {
  const log: RunnerEvent[] = [];
  let tick = 0;
  return {
    log,
    record(name, detail) {
      log.push({ at: tick++, name, detail });
    },
  };
}

export function eventNames(log: RunnerEvent[]): string[] {
  return log.map((e) => e.name);
}

export class RecordingBackend implements SandboxBackend {
  prepareOptions?: BackendPrepareOptions;
  lastRunSpec?: ExecSpec;
  lastSpawnSpec?: SpawnSpec;
  shouldFailPrepare?: Error;
  shouldFailRun?: Error;
  shouldFailSpawn?: Error;
  runResult: BackendRunResult = {
    exitCode: 0,
    stdout: 'ok',
    stderr: '',
    timedOut: false,
    meta: { isolationLevel: 'full', backend: 'docker', degraded: false, degradationReasons: [] },
  };
  carrier: ProxyCarrier;

  constructor(
    public readonly kind: BackendKind,
    public readonly isolationLevel: IsolationLevel,
    private readonly rec: (name: string, detail?: unknown) => void,
    opts?: { probeResult?: boolean; carrier?: ProxyCarrier },
  ) {
    this.probeResult = opts?.probeResult ?? true;
    this.carrier = opts?.carrier ?? {
      kind: 'in-process',
      listenHost: '10.0.0.1',
      reachableHost: '10.0.0.1',
    };
  }
  private probeResult: boolean;

  async probe(): Promise<boolean> {
    this.rec(`backend.probe:${this.kind}`);
    return this.probeResult;
  }
  async prepareTopology(): Promise<ProxyCarrier> {
    this.rec(`backend.prepareTopology:${this.kind}`);
    return this.carrier;
  }
  async prepare(opts: BackendPrepareOptions): Promise<void> {
    this.rec(`backend.prepare:${this.kind}`, opts);
    this.prepareOptions = opts;
    if (this.shouldFailPrepare) throw this.shouldFailPrepare;
  }
  async run(spec: ExecSpec): Promise<BackendRunResult> {
    this.rec(`backend.run:${this.kind}`, spec);
    this.lastRunSpec = spec;
    if (this.shouldFailRun) throw this.shouldFailRun;
    return this.runResult;
  }
  async spawn(spec: SpawnSpec): Promise<SandboxProcess> {
    this.rec(`backend.spawn:${this.kind}`, spec);
    this.lastSpawnSpec = spec;
    if (this.shouldFailSpawn) throw this.shouldFailSpawn;
    const stdin = new PassThrough();
    const stdout = new PassThrough();
    const stderr = new PassThrough();
    const exited = Promise.resolve<BackendRunResult>(this.runResult);
    return {
      stdin,
      stdout,
      stderr,
      exited,
      kill: async () => {
        this.rec(`process.kill:${this.kind}`);
      },
      close: async () => {
        this.rec(`process.close:${this.kind}`);
      },
    };
  }
  async cleanup(): Promise<void> {
    this.rec(`backend.cleanup:${this.kind}`);
  }
}

export class RecordingProxyLauncher implements ProxyLauncher {
  reachableAddr = 'http://10.0.0.1:8888';
  caBundlePath = '/tmp/host-ca/ca.pem';
  shouldFail?: Error;

  constructor(private readonly rec: (name: string, detail?: unknown) => void) {}

  async launch(
    opts: { policy: SandboxPolicy; secrets: ResolvedSecrets; workDir: string },
    carrier: ProxyCarrier,
  ): Promise<ProxyHandle> {
    this.rec('proxy.launch', { policy: opts.policy, secrets: opts.secrets, carrier });
    if (this.shouldFail) throw this.shouldFail;
    return {
      reachableAddr: this.reachableAddr,
      caBundlePath: this.caBundlePath,
      close: async () => {
        this.rec('proxy.close');
      },
    };
  }
}

export class RecordingSecretProvider implements SecretProvider {
  values = new Map<string, string>();
  calls: Array<{ installationId: string; key: string }> = [];
  async resolve(identity: InstallationIdentity, key: string): Promise<string | undefined> {
    this.calls.push({ installationId: identity.installationId, key });
    return this.values.get(`${identity.installationId}:${key}`) ?? this.values.get(key);
  }
}

export function makeSkillFixture(opts?: {
  name?: string;
  sandboxBlock?: { hosts?: string[]; credentials?: string[]; bins?: string[] };
  instructions?: string;
}): { dir: string; skill: LoadedSkill } {
  const name = opts?.name ?? 'weather';
  const instructions = opts?.instructions ?? 'call https://wttr.in';
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'oct-runner-skill-'));
  fs.writeFileSync(
    path.join(dir, 'SKILL.md'),
    `---\nname: ${name}\ndescription: d\n---\n${instructions}\n`,
  );
  const sandbox = opts?.sandboxBlock ?? {};
  const skill = {
    dirPath: dir,
    manifest: {
      name,
      description: 'd',
      adapter: 'subprocess',
      sandbox,
      credentials: [],
      metadata: {},
    },
  } as unknown as LoadedSkill;
  return { dir, skill };
}

export function makeTrustedConfig(overrides?: Partial<SandboxConfig>): SandboxConfig {
  const base: SandboxConfig = {
    defaultBackend: 'auto',
    minIsolationLevel: 'full',
    runtimeProfiles: {
      node: {
        bins: ['node'],
        path: '/usr/local/bin:/usr/bin:/bin',
        dockerImage:
          'node@sha256:aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa',
      },
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
  };
  return { ...base, ...(overrides ?? {}) } as SandboxConfig;
}

export function makeSnapshotStore(): string {
  return fs.mkdtempSync(path.join(os.tmpdir(), 'oct-runner-store-'));
}

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

describe('SandboxRunner — orchestration order and fail-closed defaults', () => {
  let storeDir: string;
  let config: SandboxConfig;

  beforeEach(() => {
    storeDir = makeSnapshotStore();
    config = makeTrustedConfig();
  });

  it('returns NO_SATISFYING_BACKEND when no backends satisfy the min isolation level', async () => {
    const { log, record } = makeEventLog();
    const weakBackend = new RecordingBackend('os', 'restricted', record, {
      probeResult: true,
    });
    const installationIdFor = () => 'inst-1';
    const runner = new SandboxRunner({
      config,
      snapshotStoreDir: storeDir,
      backends: [weakBackend],
      proxyLauncher: new RecordingProxyLauncher(record),
      secretProvider: new RecordingSecretProvider(),
      installationIdFor,
      onEvent: record,
    });
    const { skill } = makeSkillFixture();
    const result = await runner.run({ skill, command: ['node', '/skill/scripts/invoke.js'] });
    expect(result.success).toBe(false);
    expect(result.error).toContain('NO_SATISFYING_BACKEND');
    expect(result.backend).toBe('none');
    // fail-closed: no prepare / no proxy launch / no run
    expect(eventNames(log)).not.toContain('proxy.launch');
    expect(eventNames(log)).not.toContain('backend.prepare:os');
    expect(eventNames(log)).not.toContain('backend.run:os');
  });

  it('selects the backend before launching the proxy (ordering invariant)', async () => {
    const { log, record } = makeEventLog();
    const backend = new RecordingBackend('docker', 'full', record);
    const runner = new SandboxRunner({
      config,
      snapshotStoreDir: storeDir,
      backends: [backend],
      proxyLauncher: new RecordingProxyLauncher(record),
      secretProvider: new RecordingSecretProvider(),
      installationIdFor: () => 'inst-1',
      onEvent: record,
    });
    const { skill } = makeSkillFixture();
    await runner.run({ skill, command: ['node', '/skill/scripts/invoke.js'] });
    const names = eventNames(log);
    const selectIdx = names.indexOf('backend.probe:docker');
    const topoIdx = names.indexOf('backend.prepareTopology:docker');
    const proxyIdx = names.indexOf('proxy.launch');
    const prepareIdx = names.indexOf('backend.prepare:docker');
    const runIdx = names.indexOf('backend.run:docker');
    expect(selectIdx).toBeGreaterThanOrEqual(0);
    expect(topoIdx).toBeGreaterThan(selectIdx);
    expect(proxyIdx).toBeGreaterThan(topoIdx);
    expect(prepareIdx).toBeGreaterThan(proxyIdx);
    expect(runIdx).toBeGreaterThan(prepareIdx);
  });

  it('compiles: identity.digest, credentials: string[], object constructors, direct selectBackend return', async () => {
    const { record } = makeEventLog();
    const backend = new RecordingBackend('docker', 'full', record);
    const runner = new SandboxRunner({
      config,
      snapshotStoreDir: storeDir,
      backends: [backend],
      proxyLauncher: new RecordingProxyLauncher(record),
      secretProvider: new RecordingSecretProvider(),
      installationIdFor: () => 'inst-1',
      onEvent: record,
    });
    const { skill } = makeSkillFixture({
      sandboxBlock: { credentials: ['WTR_API_KEY'] },
    });
    await runner.run({ skill, command: ['node', '/skill/scripts/invoke.js'] });
    expect(backend.prepareOptions).toBeDefined();
    // Resolved credentials are an ARRAY of grants (filter of trusted credentials by requested key).
    expect(Array.isArray(backend.prepareOptions!.credentials)).toBe(true);
    // identity comes through with the digest the runner computed.
    expect(typeof backend.prepareOptions!.snapshotRoot).toBe('string');
    expect(backend.prepareOptions!.guestSkillRoot).toBe('/skill');
    expect(backend.prepareOptions!.guestCaBundlePath).toBe('/etc/skill-ca/ca.pem');
  });

  it('bind() returns a BoundSandboxExecutionPort that binds the LoadedSkill before the adapter sees it', async () => {
    const { record } = makeEventLog();
    const backend = new RecordingBackend('docker', 'full', record);
    const runner = new SandboxRunner({
      config,
      snapshotStoreDir: storeDir,
      backends: [backend],
      proxyLauncher: new RecordingProxyLauncher(record),
      secretProvider: new RecordingSecretProvider(),
      installationIdFor: () => 'inst-1',
      onEvent: record,
    });
    const { skill } = makeSkillFixture();
    const bound = runner.bind(skill);
    const result = await bound.run({ command: ['node', '/skill/scripts/invoke.js'] });
    expect(result.success).toBe(true);
    expect(backend.prepareOptions?.snapshotRoot).toContain(storeDir);
  });

  it('rejects caller attempts to override reserved env vars (OCTOPUS_INPUT, PATH, HOME, proxy, CA)', async () => {
    const { record } = makeEventLog();
    const backend = new RecordingBackend('docker', 'full', record);
    const runner = new SandboxRunner({
      config,
      snapshotStoreDir: storeDir,
      backends: [backend],
      proxyLauncher: new RecordingProxyLauncher(record),
      secretProvider: new RecordingSecretProvider(),
      installationIdFor: () => 'inst-1',
      onEvent: record,
    });
    const { skill } = makeSkillFixture();
    const result = await runner.run({
      skill,
      command: ['node', '/skill/scripts/invoke.js'],
      invocation: {
        env: {
          OCTOPUS_INPUT: '{"evil":true}',
          PATH: '/evil',
          HOME: '/evil',
          HTTP_PROXY: 'http://evil',
          SSL_CERT_FILE: '/evil.pem',
        },
      },
    });
    expect(result.success).toBe(false);
    expect(result.error).toMatch(/reserved/i);
    expect(backend.lastRunSpec).toBeUndefined();
  });

  it('constructor throws when snapshotStoreDir is absent', () => {
    const { record } = makeEventLog();
    expect(
      () =>
        new SandboxRunner({
          config,
          snapshotStoreDir: undefined as unknown as string,
          backends: [new RecordingBackend('docker', 'full', record)],
          proxyLauncher: new RecordingProxyLauncher(record),
          secretProvider: new RecordingSecretProvider(),
          installationIdFor: () => 'inst-1',
        }),
    ).toThrow(/snapshotStoreDir is REQUIRED/);
  });
});
