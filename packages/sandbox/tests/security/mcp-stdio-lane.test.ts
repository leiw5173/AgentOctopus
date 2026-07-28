/**
 * Plan 6 Task 4b — MCP stdio e2e through the persistent duplex `SandboxProcess`
 * transport over the REAL Docker backend.
 *
 * This lane proves the Plan 5 persistent-MCP contract end to end against a real
 * sandboxed process: MULTIPLE newline-delimited JSON-RPC messages traverse ONE
 * long-lived child spawned through the skill-bound execution port, the process
 * is reaped on close, malformed frames surface via `onerror` without killing the
 * session, and a peer exit fires `onclose` exactly once and rejects later sends.
 *
 * CONTRACT NOTE (Plan 5 convergence): the Plan 6 brief (lines 647-648) shows a
 * STALE `SandboxMcpTransport({ backend: SandboxBackend, ... })` signature. Plan 5
 * Task 5 converged on `SandboxMcpTransport({ port: BoundSandboxExecutionPort,
 * command, env?, timeoutMs })`. This lane uses the CONVERGED contract.
 *
 * LEAF-PACKAGE NOTE: `packages/sandbox` imports NOTHING from
 * `@agentoctopus/{core,registry,adapters,skills}`. `SandboxMcpTransport` lives in
 * `@agentoctopus/adapters` and `SandboxRunner` in `@agentoctopus/core`, so this
 * leaf test CANNOT import them. Instead it:
 *   1. runs the canonical orchestration order itself (select → prepareTopology →
 *      proxy launch → verifySnapshot → prepare) via the shared Docker-lane setup,
 *      exactly what `SandboxRunner.prepareSession()` does in core;
 *   2. wraps the prepared backend's `spawn()` in a structural
 *      `BoundSandboxExecutionPort` (the same shape `sandboxRunner.bind(skill)`
 *      returns — declared in packages/adapters/src/adapter.ts);
 *   3. drives the persistent transport with this package's OWN framing
 *      primitives (`frameMessage` / `createFrameParser` / `MalformedFrameError`),
 *      byte-for-byte the same parser `SandboxMcpTransport` uses.
 *
 * The MCP stub server is direct-Node newline-delimited JSON-RPC — no shell, no
 * host files, no curl/wget (the runtime image ships none of those). Every
 * assertion is an EXTERNALLY OBSERVABLE invariant.
 *
 * Gated on a REAL Docker daemon via probeDocker + both pinned images.
 */

import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import crypto from 'node:crypto';
import { mkdtemp, writeFile, rm } from 'node:fs/promises';
import { describe, it, expect, beforeAll } from 'vitest';

import { runDocker } from '../../src/docker/cli.js';
import { createFrameParser, frameMessage, MalformedFrameError } from '../../src/mcp-stdio-relay.js';
import type { SandboxProcess } from '../../src/backend.js';
import { SandboxConfigSchema } from '../../src/schema.js';
import { buildSnapshot, verifySnapshot } from '../../src/snapshot.js';
import { resolvePolicy, type SandboxPolicy } from '../../src/policy.js';
import { selectBackend, type ResolvedRuntimeProfile } from '../../src/backend.js';
import { DockerBackend } from '../../src/docker/docker-backend.js';
import { DefaultProxyLauncher, type ProxyHandle } from '../../src/proxy/launcher.js';
import type { SandboxSkillDescriptor } from '../../src/types.js';
import { createHostCanary, probeDocker, makeProbeSkill, requirePinnedImageRef } from './harness.js';
import type { DockerSandbox } from './docker-lane-setup.js';

const RUN_TIMEOUT = 120_000;

let dockerAvailable = false;
beforeAll(async () => {
  dockerAvailable = (await probeDocker()).available;
});

function needDocker(ctx: unknown): boolean {
  if (!dockerAvailable) { (ctx as { skip: () => void }).skip(); return false; }
  return true;
}

// ---------------------------------------------------------------------------
// Multi-message MCP stub server (newline-delimited JSON-RPC).
//
// Implements: initialize, notifications/initialized, probe/report, probe/count,
// probe/spawn-child, probe/crash (peer-exit case), shutdown, exit. It stays
// alive until `exit` or its stdin closes. Direct Node stdlib only.
// ---------------------------------------------------------------------------

const MCP_SERVER_REL = 'server.js';
const MCP_SERVER_SCRIPT = `import { readFileSync, writeFileSync } from 'node:fs';
import { spawn } from 'node:child_process';

let count = 0;
let buffer = '';
const send = (obj) => process.stdout.write(JSON.stringify(obj) + '\\n');

// Grandchild-marker mode: when launched with --grandchild, sleep briefly then
// write a marker file. If the sandbox fails to reap the process tree, this file
// appears AFTER the parent container is destroyed.
if (process.argv[2] === '--grandchild') {
  const marker = process.env.SURVIVOR_MARKER;
  const delayMs = Number(process.env.GRANDCHILD_DELAY_MS || 800);
  setTimeout(() => {
    try { if (marker) writeFileSync(marker, 'survived:' + Date.now()); } catch {}
  }, delayMs);
  // keep the grandchild alive past the marker write
  setTimeout(() => process.exit(0), delayMs + 2000);
} else {
  process.stdin.setEncoding('utf8');
  process.stdin.on('data', (chunk) => {
    buffer += chunk;
    let nl;
    while ((nl = buffer.indexOf('\\n')) >= 0) {
      const line = buffer.slice(0, nl).trim();
      buffer = buffer.slice(nl + 1);
      if (!line) continue;
      let msg;
      try { msg = JSON.parse(line); } catch { continue; }
      handle(msg);
    }
  });
  process.stdin.on('end', () => process.exit(0));
}

function handle(msg) {
  const id = msg.id;
  const reply = (result) => { if (id !== undefined) send({ jsonrpc: '2.0', id, result }); };
  switch (msg.method) {
    case 'initialize':
      reply({ protocolVersion: '2024-11-05', capabilities: {}, serverInfo: { name: 'mcp-lane-stub', version: '0.0.1' } });
      break;
    case 'notifications/initialized':
      break; // notification — no response
    case 'probe/count':
      count += 1;
      reply({ count });
      break;
    case 'probe/report': {
      // hostSecretPresent: was the host-only secret env forwarded into the guest?
      const hostSecretPresent = Boolean(process.env.OCTOPUS_HOST_SECRET_CANARY);
      // hostCanaryReadable: can the guest read the unique unmounted host canary?
      let hostCanaryReadable = false;
      const p = process.env.HOST_CANARY_PATH;
      if (p) { try { readFileSync(p, 'utf8'); hostCanaryReadable = true; } catch { hostCanaryReadable = false; } }
      reply({ cwd: process.cwd(), hostSecretPresent, hostCanaryReadable });
      break;
    }
    case 'probe/spawn-child': {
      // Detached grandchild that writes a marker AFTER the parent is reaped.
      const child = spawn(process.execPath, [__filename_esm(), '--grandchild'], { detached: true, stdio: 'ignore' });
      child.unref();
      reply({ spawned: child.pid ?? null });
      break;
    }
    case 'probe/crash':
      // Peer-exit case: terminate mid-session with NO response.
      process.exit(0);
      break;
    case 'shutdown':
      reply(null);
      break;
    case 'exit':
      process.exit(0);
      break;
    default:
      if (id !== undefined) send({ jsonrpc: '2.0', id, error: { code: -32601, message: 'method not found' } });
  }
}

// ESM has no __filename; resolve the script path from import.meta.url.
function __filename_esm() {
  return new URL(import.meta.url).pathname;
}
`;

// A variant that emits a MALFORMED (non-JSON) line for a specific method, so
// the transport's onerror fires while the process stays alive. The emitted line
// is a real newline-terminated non-JSON line, which the frame parser rejects.
const MCP_MALFORMED_SERVER_SCRIPT = MCP_SERVER_SCRIPT.replace(
  "    case 'probe/count':",
  `    case 'probe/bad':
      process.stdout.write('this is not json' + '\\n');
      break;
    case 'probe/count':`,
);

// ---------------------------------------------------------------------------
// BoundSandboxExecutionPort (structural — mirrors packages/adapters adapter.ts).
//
// Declared locally because the leaf package cannot import @agentoctopus/adapters.
// The shape is IDENTICAL: run + spawn over a prepared backend. Here `spawn` is
// the whole point (persistent MCP duplex); `run` throws to prove MCP never uses
// the one-shot path.
// ---------------------------------------------------------------------------

interface SessionHandle {
  readonly process: SandboxProcess;
  close(): Promise<void>;
}

interface BoundPort {
  run(): Promise<never>;
  spawn(input: { command: string[]; invocation?: { env?: Record<string, string> }; timeoutMs?: number }): Promise<SessionHandle>;
}

function bindBackendPort(backend: DockerSandbox['backend']): BoundPort {
  return {
    run: async () => {
      throw new Error('MCP must use spawn(), not one-shot run()');
    },
    spawn: async (input) => {
      const process = await backend.spawn({
        command: input.command,
        cwd: '/skill',
        env: input.invocation?.env,
        timeoutMs: input.timeoutMs,
      });
      return { process, close: async () => { await process.close(); } };
    },
  };
}

// ---------------------------------------------------------------------------
// Minimal persistent transport over the bound port, driven by this package's
// OWN framing primitives — byte-for-byte the same logic as
// packages/adapters/src/sandbox-mcp-transport.ts. This proves the Plan 5
// transport contract without the leaf package importing adapters.
// ---------------------------------------------------------------------------

class LaneMcpTransport {
  onmessage?: (message: any) => void;
  onerror?: (error: Error) => void;
  onclose?: () => void;

  private session: SessionHandle | undefined;
  private closed = false;

  constructor(private readonly opts: { port: BoundPort; command: string[]; env?: Record<string, string>; timeoutMs: number }) {}

  async start(): Promise<void> {
    const session = await this.opts.port.spawn({
      command: this.opts.command,
      invocation: this.opts.env ? { env: this.opts.env } : undefined,
      timeoutMs: this.opts.timeoutMs,
    });
    this.session = session;
    const process = session.process;
    const parse = createFrameParser((message) => this.onmessage?.(message));
    process.stdout.on('data', (chunk: Uint8Array | string) => {
      try {
        parse(chunk);
      } catch (err) {
        this.onerror?.(err instanceof Error ? err : new Error(String(err)));
      }
    });
    process.stderr.on('data', () => { /* diagnostics channel — never parsed */ });
    void process.exited
      .then(() => this.handleProcessEnd())
      .catch((err) => {
        this.onerror?.(err instanceof Error ? err : new Error(String(err)));
        this.handleProcessEnd();
      });
  }

  async send(message: unknown): Promise<void> {
    if (!this.session) throw new Error('transport not started');
    if (this.closed) throw new Error('transport is closed');
    const framed = frameMessage(message);
    await new Promise<void>((resolve, reject) => {
      this.session!.process.stdin.write(framed, (err?: Error | null) => (err ? reject(err) : resolve()));
    });
  }

  async close(): Promise<void> {
    if (this.closed) return;
    this.closed = true;
    const session = this.session;
    this.session = undefined;
    try {
      await session?.close();
    } finally {
      this.onclose?.();
    }
  }

  private handleProcessEnd(): void {
    if (this.closed) return;
    this.closed = true;
    this.session = undefined;
    this.onclose?.();
  }
}

// ---------------------------------------------------------------------------
// rpc helper: send a request and await its matching-id response.
// ---------------------------------------------------------------------------

function rpc(transport: LaneMcpTransport, request: { id: number; method: string; params?: unknown }): Promise<any> {
  return new Promise((resolve, reject) => {
    const timer = setTimeout(() => reject(new Error(`rpc timeout waiting for id ${request.id}`)), 15_000);
    const prev = transport.onmessage;
    transport.onmessage = (message: any) => {
      prev?.(message);
      if (message && message.id === request.id) {
        clearTimeout(timer);
        transport.onmessage = prev;
        resolve(message);
      }
    };
    transport.send({ jsonrpc: '2.0', ...request }).catch((err) => {
      clearTimeout(timer);
      reject(err);
    });
  });
}

// ---------------------------------------------------------------------------
// prepareSessionPort — build a real Docker sandbox with the MCP server script
// injected into the skill snapshot, return a bound port + liveness assertion.
// ---------------------------------------------------------------------------

interface PreparedSession {
  sandbox: DockerSandbox;
  port: BoundPort;
  /** Assert no live Docker resources remain for this session (runtime + proxy). */
  assertNoLiveResources(): Promise<void>;
  cleanup(): Promise<void>;
}

async function prepareSessionPort(opts: { serverScript: string }): Promise<PreparedSession> {
  // Capture the set of octopus proxy/runtime containers that already exist, so
  // the liveness assertion only flags containers THIS session leaked.
  const beforeIds = new Set(
    (await runDocker(['ps', '-aq', '--filter', 'name=octopus-'])).stdout
      .split('\n').map((s) => s.trim()).filter(Boolean),
  );

  // Build the sandbox via the canonical order with the MCP server script
  // injected into the skill snapshot (helper below).
  const sandbox = await setupDockerSandboxWithServer(opts.serverScript);

  return {
    sandbox,
    port: bindBackendPort(sandbox.backend),
    assertNoLiveResources: async () => {
      // Poll: backend teardown (docker rm -f) is fire-and-forget.
      const deadline = Date.now() + 10_000;
      let leaked: string[] = [];
      for (;;) {
        const nowIds = (await runDocker(['ps', '-aq', '--filter', 'name=octopus-'])).stdout
          .split('\n').map((s) => s.trim()).filter(Boolean);
        leaked = nowIds.filter((id) => !beforeIds.has(id));
        if (leaked.length === 0) break;
        if (Date.now() > deadline) break;
        await new Promise((r) => setTimeout(r, 100));
      }
      expect(leaked, `leaked sandbox containers: ${leaked.join(',')}`).toEqual([]);
    },
    cleanup: () => sandbox.cleanup(),
  };
}

/**
 * Identical to setupDockerSandbox but injects the MCP server script into the
 * skill snapshot. Reimplemented here (rather than editing the Task 2 shared
 * helper) so this lane owns its fixture without touching Task 2's file. The
 * orchestration order is preserved verbatim.
 */
async function setupDockerSandboxWithServer(serverScript: string): Promise<DockerSandbox> {
  // Same building blocks and orchestration order as the shared Task 2 helper,
  // with the MCP server script injected into the skill snapshot. Reimplemented
  // here (rather than editing the Task 2 shared helper) so this lane owns its
  // fixture without touching Task 2's file.
  const runtimeImage = requirePinnedImageRef('runtime', process.env.OCTOPUS_TEST_RUNTIME_IMAGE!);
  const proxyImage = requirePinnedImageRef('proxy', process.env.OCTOPUS_TEST_PROXY_IMAGE!);

  const sessionId = crypto.randomUUID().slice(0, 8);
  const workDir = await mkdtemp(path.join(os.tmpdir(), 'octopus-mcplane-'));
  const skillSrc = await mkdtemp(path.join(os.tmpdir(), 'octopus-mcplane-skill-'));
  await makeProbeSkill(skillSrc);
  await writeFile(path.join(skillSrc, MCP_SERVER_REL), serverScript, 'utf8');

  const snapshot = await buildSnapshot({
    sourceDir: skillSrc,
    storeDir: path.join(workDir, 'store'),
    installationId: `mcp-lane-${sessionId}`,
    name: 'mcp-lane-stub',
  });

  const config = SandboxConfigSchema.parse({
    docker: { image: runtimeImage },
    proxy: { artifact: proxyImage },
    defaults: { timeoutMs: 30_000, outputMaxBytes: 65_536 },
  });

  const descriptor: SandboxSkillDescriptor = {
    identity: snapshot.identity,
    snapshotRoot: snapshot.snapshotRoot,
    request: {},
  };
  const runtimeProfile: ResolvedRuntimeProfile = {
    id: 'mcp-lane',
    bins: ['node'],
    path: '/usr/local/bin',
    dockerImage: runtimeImage,
  };

  const backend = new DockerBackend({ config, sessionId });
  const selected = await selectBackend(config, [backend]);

  let cleaned = false;
  let proxy: ProxyHandle | undefined;
  const cleanup = async (): Promise<void> => {
    if (cleaned) return;
    cleaned = true;
    if (proxy) await proxy.close().catch(() => {});
    await selected.cleanup().catch(() => {});
    await rm(skillSrc, { recursive: true, force: true }).catch(() => {});
    await rm(workDir, { recursive: true, force: true }).catch(() => {});
  };

  let policy: SandboxPolicy;
  try {
    const carrier = await selected.prepareTopology();
    if (carrier.kind !== 'docker-sidecar') throw new Error(`expected docker-sidecar, got ${carrier.kind}`);
    policy = resolvePolicy(descriptor, config);
    proxy = await new DefaultProxyLauncher().launch({ policy, secrets: {}, workDir }, carrier);
    const verified = await verifySnapshot(snapshot.snapshotRoot, snapshot.identity.digest);
    if (!verified) throw new Error('snapshot verification failed');
    await selected.prepare({
      ...policy,
      snapshotRoot: snapshot.snapshotRoot,
      proxyAddr: proxy.reachableAddr,
      caBundlePath: proxy.caBundlePath,
      runtimeProfile,
      guestSkillRoot: '/skill',
      guestCaBundlePath: '/etc/skill-ca/ca.pem',
    });
  } catch (err) {
    await cleanup();
    throw err;
  }

  return {
    backend: selected,
    proxy: proxy!,
    snapshot,
    policy: policy!,
    config,
    workDir,
    runtimeContainerName: `octopus-sbx-runtime-${sessionId}`,
    internalNetwork: `octopus-sbx-${sessionId}-internal`,
    egressNetwork: `octopus-sbx-${sessionId}-egress`,
    cleanup,
  };
}

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

describe('MCP stdio lane — persistent duplex transport over Docker', () => {
  it('exchanges multiple JSON-RPC messages over one sandboxed process and reaps it on close', async (ctx) => {
    if (!needDocker(ctx)) return;
    const canary = createHostCanary();
    const marker = path.join(os.tmpdir(), `oct-mcp-survivor-${crypto.randomUUID()}`);
    process.env.OCTOPUS_HOST_SECRET_CANARY = 'host-only-value';

    const prepared = await prepareSessionPort({ serverScript: MCP_SERVER_SCRIPT });
    const transport = new LaneMcpTransport({
      port: prepared.port,
      command: ['node', '/skill/server.js'],
      env: {
        HOST_CANARY_PATH: canary.containerPath,
        SURVIVOR_MARKER: marker,
        GRANDCHILD_DELAY_MS: '800',
      },
      timeoutMs: 30_000,
    });

    try {
      await transport.start();
      const init = await rpc(transport, { id: 1, method: 'initialize', params: {} });
      expect(init.result.serverInfo.name).toBe('mcp-lane-stub');
      await transport.send({ jsonrpc: '2.0', method: 'notifications/initialized' });

      // Two sequential probe/count calls prove BOTH messages hit the SAME
      // process (process-local counter increments across messages).
      const first = await rpc(transport, { id: 2, method: 'probe/count' });
      const second = await rpc(transport, { id: 3, method: 'probe/count' });
      const report = await rpc(transport, { id: 4, method: 'probe/report' });
      await rpc(transport, { id: 5, method: 'probe/spawn-child' });

      expect(first.result.count).toBe(1);
      expect(second.result.count).toBe(2);
      expect(report.result.cwd).toBe('/skill');
      // The host-only secret env was NOT forwarded into the guest.
      expect(report.result.hostSecretPresent).toBe(false);
      // The unique unmounted host canary is NOT readable inside the sandbox.
      expect(report.result.hostCanaryReadable).toBe(false);
      // Host canary file is intact.
      expect(fs.readFileSync(canary.hostPath, 'utf8')).toBe(canary.content);
    } finally {
      await transport.close();
      await prepared.cleanup();
      canary.cleanup();
      delete process.env.OCTOPUS_HOST_SECRET_CANARY;
    }

    // The detached grandchild marker must NEVER appear: destroying the runtime
    // container reaps the WHOLE process tree, so the delayed write never lands.
    await new Promise((r) => setTimeout(r, 2_500));
    expect(fs.existsSync(marker)).toBe(false);
    await prepared.assertNoLiveResources();
  }, RUN_TIMEOUT);

  it('surfaces a malformed JSON response via onerror and still reaps on close', async (ctx) => {
    if (!needDocker(ctx)) return;
    const prepared = await prepareSessionPort({ serverScript: MCP_MALFORMED_SERVER_SCRIPT });
    const transport = new LaneMcpTransport({
      port: prepared.port,
      command: ['node', '/skill/server.js'],
      timeoutMs: 30_000,
    });

    const errors: Error[] = [];
    transport.onerror = (e) => errors.push(e);

    try {
      await transport.start();
      await rpc(transport, { id: 1, method: 'initialize', params: {} });

      // Trigger the malformed line; the process stays alive afterwards.
      const badSeen = new Promise<void>((resolve) => {
        const timer = setInterval(() => {
          if (errors.some((e) => e instanceof MalformedFrameError)) { clearInterval(timer); resolve(); }
        }, 25);
        setTimeout(() => { clearInterval(timer); resolve(); }, 10_000);
      });
      await transport.send({ jsonrpc: '2.0', id: 2, method: 'probe/bad' });
      await badSeen;

      expect(errors.some((e) => e instanceof MalformedFrameError)).toBe(true);

      // Session is still usable after the malformed frame.
      const ok = await rpc(transport, { id: 3, method: 'probe/count' });
      expect(ok.result.count).toBe(1);
    } finally {
      // close() still reaps the process even after a malformed frame.
      await transport.close();
      await prepared.cleanup();
    }
    await prepared.assertNoLiveResources();
  }, RUN_TIMEOUT);

  it('fires onclose exactly once on peer exit and rejects subsequent send()', async (ctx) => {
    if (!needDocker(ctx)) return;
    const prepared = await prepareSessionPort({ serverScript: MCP_SERVER_SCRIPT });
    const transport = new LaneMcpTransport({
      port: prepared.port,
      command: ['node', '/skill/server.js'],
      timeoutMs: 30_000,
    });

    let closeCount = 0;
    transport.onclose = () => { closeCount += 1; };

    await transport.start();
    await rpc(transport, { id: 1, method: 'initialize', params: {} });

    // Peer exits mid-session with no response. onclose must fire exactly once.
    await transport.send({ jsonrpc: '2.0', id: 2, method: 'probe/crash' });
    const deadline = Date.now() + 10_000;
    while (closeCount === 0 && Date.now() < deadline) {
      await new Promise((r) => setTimeout(r, 25));
    }
    // Allow any duplicate fired-close to surface.
    await new Promise((r) => setTimeout(r, 200));
    expect(closeCount).toBe(1);

    // Subsequent send() rejects because the transport is closed.
    await expect(transport.send({ jsonrpc: '2.0', id: 3, method: 'probe/count' })).rejects.toThrow();

    // close() after a peer-exit close is idempotent (no second onclose).
    await transport.close();
    expect(closeCount).toBe(1);

    await prepared.cleanup();
    await prepared.assertNoLiveResources();
  }, RUN_TIMEOUT);
});
