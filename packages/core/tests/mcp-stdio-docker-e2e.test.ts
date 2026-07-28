/**
 * Plan 6 Task 4b — production MCP stdio e2e over the real Docker sandbox.
 *
 * Dependency-legal integration layer: core depends on adapters + sandbox, so
 * this test can exercise the ACTUAL production path end to end:
 *
 *   SandboxRunner.bind(skill) → BoundSandboxExecutionPort.spawn()
 *   → SandboxMcpTransport → DockerBackend.spawn() → SandboxProcess
 *
 * This covers canonical prepareSession ordering, snapshot construction and
 * verification, command rewriting, buildGuestEnv hygiene, the real persistent
 * transport, and session-owned process/backend/proxy cleanup.
 */

import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import crypto from 'node:crypto';
import { describe, it, expect, beforeAll } from 'vitest';
import type { LoadedSkill } from '@agentoctopus/registry';
import {
  DockerBackend,
  SandboxConfigSchema,
  runDocker,
  type SandboxConfig,
} from '@agentoctopus/sandbox';
import { SandboxMcpTransport } from '../../adapters/src/sandbox-mcp-transport.js';
import { SandboxRunner } from '../src/sandbox-runner.js';

const RUN_TIMEOUT = 120_000;
const RPC_TIMEOUT = 15_000;

const MCP_SERVER_SCRIPT = `import { readFileSync } from 'node:fs';
import { spawn } from 'node:child_process';

let count = 0;
let buffer = '';
const send = (value) => process.stdout.write(JSON.stringify(value) + '\\n');

process.stdin.setEncoding('utf8');
process.stdin.on('data', (chunk) => {
  buffer += chunk;
  let nl;
  while ((nl = buffer.indexOf('\\n')) >= 0) {
    const line = buffer.slice(0, nl).trim();
    buffer = buffer.slice(nl + 1);
    if (!line) continue;
    let message;
    try { message = JSON.parse(line); } catch { continue; }
    handle(message);
  }
});
process.stdin.on('end', () => process.exit(0));

function handle(message) {
  const id = message.id;
  const reply = (result) => {
    if (id !== undefined) send({ jsonrpc: '2.0', id, result });
  };

  switch (message.method) {
    case 'initialize':
      reply({
        protocolVersion: '2024-11-05',
        capabilities: {},
        serverInfo: { name: 'mcp-docker-e2e', version: '0.0.1' },
      });
      break;
    case 'notifications/initialized':
      break;
    case 'probe/count':
      count += 1;
      reply({ count });
      break;
    case 'probe/report': {
      let hostCanaryReadable = false;
      const canaryPath = process.env.HOST_CANARY_PATH;
      if (canaryPath) {
        try { readFileSync(canaryPath, 'utf8'); hostCanaryReadable = true; }
        catch { hostCanaryReadable = false; }
      }
      reply({
        cwd: process.cwd(),
        hostSecretPresent: Boolean(process.env.OCTOPUS_HOST_SECRET_CANARY),
        hostCanaryReadable,
      });
      break;
    }
    case 'probe/spawn-child': {
      const child = spawn(process.execPath, ['-e', 'setInterval(() => {}, 60000)'], {
        detached: true,
        stdio: 'ignore',
      });
      child.unref();
      reply({ spawned: child.pid ?? null });
      break;
    }
    case 'probe/bad':
      process.stdout.write('this is not json' + '\\n');
      break;
    case 'probe/crash':
      process.exit(0);
      break;
    case 'shutdown':
      reply(null);
      break;
    case 'exit':
      process.exit(0);
      break;
    default:
      if (id !== undefined) {
        send({ jsonrpc: '2.0', id, error: { code: -32601, message: 'method not found' } });
      }
  }
}
`;

interface DockerTestFixture {
  backend: DockerBackend;
  config: SandboxConfig;
  port: ReturnType<SandboxRunner['bind']>;
  runtimeContainerName: string;
  internalNetworkName: string;
  egressNetworkName: string;
  beforeContainerIds: Set<string>;
  skillDir: string;
  storeDir: string;
  fallbackCleanup(): Promise<void>;
}

let dockerAvailable = false;
beforeAll(async () => {
  const info = await runDocker(['info', '--format', '{{.ServerVersion}}']);
  dockerAvailable = info.code === 0 && Boolean(process.env.OCTOPUS_TEST_RUNTIME_IMAGE) && Boolean(process.env.OCTOPUS_TEST_PROXY_IMAGE);
});

function needDocker(ctx: unknown): boolean {
  if (!dockerAvailable) {
    (ctx as { skip: () => void }).skip();
    return false;
  }
  return true;
}

function requiredImage(name: string): string {
  const value = process.env[name];
  if (!value) throw new Error(`${name} is required`);
  return value;
}

async function listOctopusContainerIds(): Promise<string[]> {
  return (await runDocker(['ps', '-aq', '--filter', 'name=octopus-'])).stdout
    .split('\n')
    .map((value) => value.trim())
    .filter(Boolean);
}

async function waitForRuntimeGone(containerName: string): Promise<void> {
  const deadline = Date.now() + 10_000;
  let ids = '';
  do {
    ids = (await runDocker(['ps', '-aq', '--filter', `name=${containerName}`])).stdout.trim();
    if (!ids) return;
    await new Promise((resolve) => setTimeout(resolve, 100));
  } while (Date.now() < deadline);
  expect(ids, `runtime container ${containerName} still exists`).toBe('');
}

async function waitForParentAndGrandchild(containerName: string): Promise<void> {
  const deadline = Date.now() + 10_000;
  let nodeCount = 0;
  do {
    const top = await runDocker(['top', containerName, '-eo', 'pid,ppid,comm']);
    nodeCount = (top.stdout.match(/node/g) ?? []).length;
    if (top.code === 0 && nodeCount >= 2) return;
    await new Promise((resolve) => setTimeout(resolve, 100));
  } while (Date.now() < deadline);
  expect(nodeCount, 'docker top must observe the MCP parent and its grandchild before close').toBeGreaterThanOrEqual(2);
}

async function assertNoNewContainers(before: Set<string>): Promise<void> {
  const deadline = Date.now() + 10_000;
  let leaked: string[] = [];
  do {
    leaked = (await listOctopusContainerIds()).filter((id) => !before.has(id));
    if (leaked.length === 0) return;
    await new Promise((resolve) => setTimeout(resolve, 100));
  } while (Date.now() < deadline);
  expect(leaked, `session-owned close leaked Docker containers: ${leaked.join(',')}`).toEqual([]);
}

function makeRpc(transport: SandboxMcpTransport): {
  request(id: number, method: string, params?: Record<string, unknown>): Promise<any>;
} {
  const pending = new Map<number, { resolve(value: any): void; reject(error: Error): void; timer: NodeJS.Timeout }>();
  transport.onmessage = (message: any) => {
    const id = typeof message?.id === 'number' ? message.id : undefined;
    if (id === undefined) return;
    const waiter = pending.get(id);
    if (!waiter) return;
    clearTimeout(waiter.timer);
    pending.delete(id);
    waiter.resolve(message);
  };
  return {
    request(id, method, params) {
      return new Promise((resolve, reject) => {
        const timer = setTimeout(() => {
          pending.delete(id);
          reject(new Error(`RPC timeout waiting for id ${id}`));
        }, RPC_TIMEOUT);
        pending.set(id, { resolve, reject, timer });
        transport.send({ jsonrpc: '2.0', id, method, ...(params === undefined ? {} : { params }) })
          .catch((error) => {
            clearTimeout(timer);
            pending.delete(id);
            reject(error);
          });
      });
    },
  };
}

async function prepareFixture(testName: string): Promise<DockerTestFixture> {
  const runtimeImage = requiredImage('OCTOPUS_TEST_RUNTIME_IMAGE');
  const proxyImage = requiredImage('OCTOPUS_TEST_PROXY_IMAGE');
  const sessionId = `mcp${crypto.randomUUID().replaceAll('-', '').slice(0, 8)}`;
  const runtimeContainerName = `octopus-sbx-runtime-${sessionId}`;
  const internalNetworkName = `octopus-sbx-${sessionId}-internal`;
  const egressNetworkName = `octopus-sbx-${sessionId}-egress`;
  const beforeContainerIds = new Set(await listOctopusContainerIds());
  const skillDir = fs.mkdtempSync(path.join(os.tmpdir(), `oct-core-${testName}-skill-`));
  const storeDir = fs.mkdtempSync(path.join(os.tmpdir(), `oct-core-${testName}-store-`));

  fs.writeFileSync(
    path.join(skillDir, 'SKILL.md'),
    `---\nname: mcp-docker-e2e\ndescription: MCP Docker test fixture\n---\nPersistent MCP fixture.\n`,
  );
  fs.writeFileSync(path.join(skillDir, 'server.js'), MCP_SERVER_SCRIPT);

  const skill = {
    dirPath: skillDir,
    manifest: {
      name: 'mcp-docker-e2e',
      description: 'MCP Docker test fixture',
      adapter: 'mcp',
      sandbox: { bins: ['node'] },
      credentials: [],
      metadata: {},
    },
    rating: 0,
  } as unknown as LoadedSkill;

  const config = SandboxConfigSchema.parse({
    defaultBackend: 'docker',
    minIsolationLevel: 'full',
    runtimeProfiles: {
      node: { bins: ['node'], path: '/usr/local/bin', dockerImage: runtimeImage },
    },
    docker: { image: runtimeImage },
    proxy: { artifact: proxyImage },
    defaults: { timeoutMs: 30_000, outputMaxBytes: 65_536 },
  });
  const backend = new DockerBackend({ config, sessionId });
  const runner = new SandboxRunner({
    config,
    snapshotStoreDir: storeDir,
    backends: [backend],
    installationIdFor: () => `mcp-e2e-${sessionId}`,
  });

  const fallbackCleanup = async (): Promise<void> => {
    await backend.cleanup().catch(() => {});
    const leakedIds = (await listOctopusContainerIds()).filter((id) => !beforeContainerIds.has(id));
    for (const id of leakedIds) await runDocker(['rm', '-f', id]);
    // DockerBackend.cleanup() may race network detach/remove behind the proxy's
    // process exit. Remove only this fixture's deterministic networks after all
    // session containers are gone; this is fallback hygiene, never the close-
    // attribution assertion above.
    await runDocker(['network', 'rm', internalNetworkName]);
    await runDocker(['network', 'rm', egressNetworkName]);
    fs.rmSync(skillDir, { recursive: true, force: true });
    fs.rmSync(storeDir, { recursive: true, force: true });
  };

  return {
    backend,
    config,
    port: runner.bind(skill),
    runtimeContainerName,
    internalNetworkName,
    egressNetworkName,
    beforeContainerIds,
    skillDir,
    storeDir,
    fallbackCleanup,
  };
}

function makeTransport(fixture: DockerTestFixture, env?: Record<string, string>): SandboxMcpTransport {
  // Host absolute path deliberately exercises SandboxRunner command rewriting:
  // the guest receives /skill/server.js, never the live source path.
  return new SandboxMcpTransport({
    port: fixture.port,
    command: ['node', path.join(fixture.skillDir, 'server.js')],
    env,
    timeoutMs: 30_000,
  });
}

describe('production MCP stdio over Docker', () => {
  it('uses one runner-bound process for multiple messages and close reaps its observed process tree', async (ctx) => {
    if (!needDocker(ctx)) return;
    const fixture = await prepareFixture('persistent');
    const canaryDir = fs.mkdtempSync(path.join(os.tmpdir(), 'oct-mcp-canary-'));
    const canaryPath = path.join(canaryDir, 'canary');
    fs.writeFileSync(canaryPath, crypto.randomUUID());
    process.env.OCTOPUS_HOST_SECRET_CANARY = 'host-only-value';
    const transport = makeTransport(fixture, { HOST_CANARY_PATH: canaryPath });

    try {
      await transport.start();
      const rpc = makeRpc(transport);
      await rpc.request(1, 'initialize', {});
      await transport.send({ jsonrpc: '2.0', method: 'notifications/initialized' });
      const first = await rpc.request(2, 'probe/count');
      const second = await rpc.request(3, 'probe/count');
      const report = await rpc.request(4, 'probe/report');
      await rpc.request(5, 'probe/spawn-child');

      expect(first.result.count).toBe(1);
      expect(second.result.count).toBe(2);
      expect(report.result).toEqual({
        cwd: '/skill',
        hostSecretPresent: false,
        hostCanaryReadable: false,
      });

      // Genuine reaping proof: observe BOTH parent + grandchild in the known
      // runtime container before close, then prove close removes that container
      // before any fallback fixture cleanup runs.
      await waitForParentAndGrandchild(fixture.runtimeContainerName);
      await transport.close();
      await waitForRuntimeGone(fixture.runtimeContainerName);
      await assertNoNewContainers(fixture.beforeContainerIds);
    } finally {
      await transport.close().catch(() => {});
      await fixture.fallbackCleanup();
      fs.rmSync(canaryDir, { recursive: true, force: true });
      delete process.env.OCTOPUS_HOST_SECRET_CANARY;
    }
  }, RUN_TIMEOUT);

  it('surfaces malformed JSON through the real transport and close still owns cleanup', async (ctx) => {
    if (!needDocker(ctx)) return;
    const fixture = await prepareFixture('malformed');
    const transport = makeTransport(fixture);
    const errors: Error[] = [];
    transport.onerror = (error) => errors.push(error);

    try {
      await transport.start();
      const rpc = makeRpc(transport);
      await rpc.request(1, 'initialize', {});
      await transport.send({ jsonrpc: '2.0', id: 2, method: 'probe/bad' });

      const deadline = Date.now() + 10_000;
      while (errors.length === 0 && Date.now() < deadline) {
        await new Promise((resolve) => setTimeout(resolve, 25));
      }
      expect(errors[0]?.name).toBe('MalformedFrameError');

      const afterMalformed = await rpc.request(3, 'probe/count');
      expect(afterMalformed.result.count).toBe(1);

      await transport.close();
      await waitForRuntimeGone(fixture.runtimeContainerName);
      await assertNoNewContainers(fixture.beforeContainerIds);
    } finally {
      await transport.close().catch(() => {});
      await fixture.fallbackCleanup();
    }
  }, RUN_TIMEOUT);

  it('fires onclose once on peer exit, rejects send, and peer cleanup leaves no session resources', async (ctx) => {
    if (!needDocker(ctx)) return;
    const fixture = await prepareFixture('peer-exit');
    const transport = makeTransport(fixture);
    let closeCount = 0;
    transport.onclose = () => { closeCount += 1; };

    try {
      await transport.start();
      const rpc = makeRpc(transport);
      await rpc.request(1, 'initialize', {});
      await transport.send({ jsonrpc: '2.0', id: 2, method: 'probe/crash' });

      const deadline = Date.now() + 10_000;
      while (closeCount === 0 && Date.now() < deadline) {
        await new Promise((resolve) => setTimeout(resolve, 25));
      }
      await new Promise((resolve) => setTimeout(resolve, 200));
      expect(closeCount).toBe(1);
      await expect(transport.send({ jsonrpc: '2.0', id: 3, method: 'probe/count' })).rejects.toThrow();

      await transport.close();
      expect(closeCount).toBe(1);
      await waitForRuntimeGone(fixture.runtimeContainerName);
      await assertNoNewContainers(fixture.beforeContainerIds);
    } finally {
      await transport.close().catch(() => {});
      await fixture.fallbackCleanup();
    }
  }, RUN_TIMEOUT);
});
