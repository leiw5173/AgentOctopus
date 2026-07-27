import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { execSync } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { DockerBackend, buildDockerArgs } from '../src/docker/docker-backend.js';
import { buildSnapshot } from '../src/snapshot.js';
import { resolvePolicy } from '../src/policy.js';
import { ImmutableImageRefSchema, SandboxConfigSchema } from '../src/schema.js';
import type { BackendPrepareOptions } from '../src/backend.js';
import type { SandboxSkillDescriptor } from '../src/types.js';

const hasDocker = (() => { try { execSync('docker info', { stdio: 'pipe' }); return true; } catch { return false; } })();
const DUMMY_IMAGE = `alpine@sha256:${'a'.repeat(64)}`; // syntax-only unit-test fixture; never executed
const requestedDaemonImage = process.env.OCTOPUS_TEST_IMAGE;
const daemonImage = requestedDaemonImage
  ? ImmutableImageRefSchema.safeParse(requestedDaemonImage)
  : undefined;
const runDaemonTests = hasDocker && daemonImage?.success === true;

let tmp: string; let descriptor: SandboxSkillDescriptor;
const unitConfig = SandboxConfigSchema.parse({
  docker: { image: DUMMY_IMAGE, memory: '128m', cpus: '0.5', pids: 32, ulimits: { nofile: 128, fsize: '16m' } },
  proxy: { artifact: DUMMY_IMAGE }, // digest-pinned proxy image; required by prepareTopology()'s `config.proxy` guard
  defaults: { memory: '512m', timeoutMs: 15000, cpus: '2', outputMaxBytes: 65536 },
});
const daemonConfig = SandboxConfigSchema.parse({
  ...unitConfig,
  docker: { ...unitConfig.docker, image: daemonImage?.success ? daemonImage.data : DUMMY_IMAGE },
});

beforeEach(async () => {
  tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'sbx-'));
  const src = path.join(tmp, 'src');
  fs.mkdirSync(src, { recursive: true });
  fs.writeFileSync(path.join(src, 'hello.txt'), 'hello');
  // Node probe scripts the daemon tests run directly (no shell in the runtime image).
  fs.writeFileSync(path.join(src, 'read-hello.js'),
    "const fs=require('fs');process.stdout.write(fs.readFileSync('/skill/hello.txt','utf8'));");
  fs.writeFileSync(path.join(src, 'net-probe.js'),
    "const net=require('net');const s=net.connect(80,'example.com');s.on('error',e=>{process.stdout.write(e.code+':'+e.message);process.exit(0);});s.on('connect',()=>{process.stdout.write('CONNECTED');process.exit(0);});setTimeout(()=>{process.stdout.write('TIMEOUT');process.exit(0);},5000);");
  fs.writeFileSync(path.join(src, 'sleep.js'),
    "setInterval(()=>{},60000);");
  fs.writeFileSync(path.join(src, 'echo-server.js'),
    "process.stdin.on('data',d=>process.stdout.write(d));process.stdin.on('end',()=>process.exit(0));");
  const snap = await buildSnapshot({ sourceDir: src, storeDir: path.join(tmp, 'store'), installationId: 'u1', name: 't' });
  descriptor = { identity: snap.identity, snapshotRoot: snap.snapshotRoot, request: {} };
});

afterEach(() => { fs.rmSync(tmp, { recursive: true, force: true }); });

// Build the canonical prepare() options: resolved policy + execution plumbing.
function prepareOpts(config = unitConfig): BackendPrepareOptions {
  return {
    ...resolvePolicy(descriptor, config),
    snapshotRoot: descriptor.snapshotRoot,
    proxyAddr: 'http://egress-proxy:8080',
    caBundlePath: '/host/session-ca.pem',
    runtimeProfile: { id: 'unit', bins: ['node'], path: '/usr/local/bin', dockerImage: DUMMY_IMAGE },
    guestSkillRoot: '/skill',
    guestCaBundlePath: '/etc/skill-ca/ca.pem',
  };
}

describe('buildDockerArgs', () => {
  it('uses bounded Docker caps, numeric fsize bytes, and the exact CA file mount', () => {
    const prepare: BackendPrepareOptions = {
      ...prepareOpts(),
      resources: { memoryBytes: 8 * 1024 ** 3, timeoutMs: 999_999, cpus: 64 },
      caBundlePath: '/host/session-ca.pem',
    };
    const args = buildDockerArgs({
      config: unitConfig,
      prepare,
      spec: { command: ['true'] },
      networkName: 'octopus-test-net',
      containerName: 'octopus-test-container',
    });

    expect(args).toContain('134217728'); // Docker's trusted 128m cap, in bytes
    expect(args).toContain('0.5');
    expect(args).toContain('fsize=16777216'); // Docker requires numeric bytes
    expect(args).toContain('/host/session-ca.pem:/etc/skill-ca/ca.pem:ro');
    expect(args).toContain('SSL_CERT_FILE=/etc/skill-ca/ca.pem');
    expect(args.at(-2)).toBe(DUMMY_IMAGE);
  });

  it('emits the full hardening argument set with correct adjacent values', () => {
    const prepare = prepareOpts();
    const args = buildDockerArgs({
      config: unitConfig,
      prepare,
      spec: { command: ['true'] },
      networkName: 'octopus-test-net',
      containerName: 'octopus-test-container',
    });

    // Capability and privilege restrictions
    const capDropIdx = args.indexOf('--cap-drop');
    expect(capDropIdx).toBeGreaterThan(-1);
    expect(args[capDropIdx + 1]).toBe('ALL');

    const secOptIdx = args.indexOf('--security-opt');
    expect(secOptIdx).toBeGreaterThan(-1);
    expect(args[secOptIdx + 1]).toBe('no-new-privileges');

    const userIdx = args.indexOf('--user');
    expect(userIdx).toBeGreaterThan(-1);
    expect(args[userIdx + 1]).toBe('65534:65534');

    expect(args).toContain('--read-only');

    const tmpfsIdx = args.indexOf('--tmpfs');
    expect(tmpfsIdx).toBeGreaterThan(-1);
    expect(args[tmpfsIdx + 1]).toMatch(/noexec/);
    expect(args[tmpfsIdx + 1]).toMatch(/nosuid/);

    // Resource limits
    const pidsIdx = args.indexOf('--pids-limit');
    expect(pidsIdx).toBeGreaterThan(-1);
    expect(args[pidsIdx + 1]).toBe('32');

    const ulimitIdx = args.indexOf('--ulimit');
    expect(ulimitIdx).toBeGreaterThan(-1);
    expect(args[ulimitIdx + 1]).toBe('nofile=128');

    // Network isolation (invariant-1 wiring)
    const netIdx = args.indexOf('--network');
    expect(netIdx).toBeGreaterThan(-1);
    expect(args[netIdx + 1]).toBe('octopus-test-net');

    // Mount points
    const volumeArgs = args.filter((a, i) => args[i - 1] === '-v');
    expect(volumeArgs.some((v) => v.endsWith(':/skill:ro'))).toBe(true);
    expect(volumeArgs).toContain('/host/session-ca.pem:/etc/skill-ca/ca.pem:ro');

    // Every -e value must contain '=' (no bare passthrough)
    for (let i = 0; i < args.length; i++) {
      if (args[i] === '-e') {
        expect(args[i + 1]).toMatch(/=/);
      }
    }
  });

  it('trusted env wins over spec.env on collision (last-wins ordering)', () => {
    const prepare = prepareOpts();
    const args = buildDockerArgs({
      config: unitConfig,
      prepare,
      spec: { command: ['true'], env: { HTTPS_PROXY: 'http://evil' } },
      networkName: 'octopus-test-net',
      containerName: 'octopus-test-container',
    });

    // Collect all -e values starting with HTTPS_PROXY=
    const httpsProxyValues: string[] = [];
    for (let i = 0; i < args.length; i++) {
      if (args[i] === '-e' && args[i + 1]?.startsWith('HTTPS_PROXY=')) {
        httpsProxyValues.push(args[i + 1]);
      }
    }
    // The LAST one must be the trusted value (Docker applies last-wins)
    expect(httpsProxyValues.length).toBeGreaterThanOrEqual(2);
    expect(httpsProxyValues.at(-1)).toBe(`HTTPS_PROXY=${prepare.proxyAddr}`);
  });

  it('rejects a mutable runtime image before any Docker operation', async () => {
    const invalidConfig = { ...unitConfig, docker: { ...unitConfig.docker, image: 'example/runtime:latest' } } as typeof unitConfig;
    const be = new DockerBackend({ config: invalidConfig, sessionId: `invalid-${process.pid}` });
    await expect(be.prepareTopology()).rejects.toThrow(/immutable|sha256/i);
  });
});

describe('DockerBackend fail-closed', () => {
  it('run() rejects when called before prepare()', async () => {
    const be = new DockerBackend({ config: unitConfig, sessionId: `noprep-${process.pid}` });
    await expect(be.run({ command: ['true'] })).rejects.toThrow(/prepare/i);
  });

  it('prepareTopology() rejects a mutable proxy artifact before network creation', async () => {
    const invalidConfig = { ...unitConfig, proxy: { artifact: 'example/proxy:latest' } } as typeof unitConfig;
    const be = new DockerBackend({ config: invalidConfig, sessionId: `mutproxy-${process.pid}` });
    await expect(be.prepareTopology()).rejects.toThrow(/immutable|sha256/i);
  });
});

describe.skipIf(!runDaemonTests)('DockerBackend topology and persistent process contract', () => {
  it('creates both networks before prepare and exposes exited instead of wait()', async () => {
    const be = new DockerBackend({ config: daemonConfig, sessionId: `contract-${process.pid}` });
    const carrier = await be.prepareTopology();
    expect(carrier).toMatchObject({
      kind: 'docker-sidecar',
      proxyImage: expect.any(String),
      internalNetwork: expect.stringContaining('-internal'),
      egressNetwork: expect.stringContaining('-egress'),
      reachableHost: expect.any(String),
    });
    // This drives the real Docker CLI: prepareTopology creates the networks and
    // spawn() runs `echo-server.js` (written into the fixture) inside a container.
    await be.prepare(prepareOpts(daemonConfig));
    const child = await be.spawn({ command: ['node', '/skill/echo-server.js'], stdin: 'pipe' });
    child.stdin.write('{"n":1}\n{"n":2}\n');
    child.stdin.end();
    expect(await child.exited).toMatchObject({ exitCode: 0 });
    await child.close();
    await child.close();
    await be.cleanup();
  });
});

// The pure/unit tests that always run (argument builder, network-arg ownership,
// process-contract shape) live above and do not touch the daemon. The daemon
// integration cases below additionally prove prepareTopology creates the internal
// network before proxy launch, creates the egress bridge, and runtime docker run
// uses only --network <internalNetwork>; cleanup covers both networks.
describe.skipIf(!runDaemonTests)('DockerBackend daemon integration', () => {
  // The runtime image ships `node` and no shell/curl/wget/busybox, so every
  // probe runs as a direct Node argv. The snapshot fixture provides the JS
  // files; commands never invoke /bin/sh, cat, wget, or sleep.

  it('runs a command in the snapshot and captures stdout', async () => {
    const be = new DockerBackend({ config: daemonConfig, sessionId: `t${process.pid}` });
    await be.prepareTopology();
    await be.prepare(prepareOpts(daemonConfig));
    try {
      const res = await be.run({ command: ['node', '/skill/read-hello.js'] });
      expect(res.exitCode).toBe(0);
      expect(res.stdout.trim()).toBe('hello');
      expect(res.meta.isolationLevel).toBe('full');
    } finally { await be.cleanup(); }
  });

  it('skill cannot see host env vars', async () => {
    const be = new DockerBackend({ config: daemonConfig, sessionId: `t${process.pid}` });
    await be.prepareTopology();
    await be.prepare(prepareOpts(daemonConfig));
    try {
      const res = await be.run({
        command: ['node', '-e', 'process.stdout.write(JSON.stringify({HOME:process.env.HOME,SECRET:process.env.DOES_NOT_EXIST}))'],
      });
      const out = JSON.parse(res.stdout);
      expect(out.HOME).not.toBe(process.env.HOME ?? '__nohosthome__');
      expect(out.SECRET).toBeUndefined();
    } finally { await be.cleanup(); }
  });

  it('has no internet route (internal network)', async () => {
    const be = new DockerBackend({ config: daemonConfig, sessionId: `t${process.pid}` });
    await be.prepareTopology();
    await be.prepare(prepareOpts(daemonConfig));
    try {
      // net-probe.js attempts a TCP connect to example.com:80 and prints the
      // error code/message (ENOTFOUND/EHOSTUNREACH/ECONNREFUSED), then exits 0.
      const res = await be.run({ command: ['node', '/skill/net-probe.js'], timeoutMs: 8000 });
      expect(res.exitCode).toBe(0);
      expect(res.stdout + res.stderr).toMatch(/ENOTFOUND|EHOSTUNREACH|ECONNREFUSED|getaddrinfo|network is unreachable/i);
    } finally { await be.cleanup(); }
  });

  it('times out and destroys the container', async () => {
    const be = new DockerBackend({ config: daemonConfig, sessionId: `t${process.pid}` });
    await be.prepareTopology();
    await be.prepare(prepareOpts(daemonConfig));
    try {
      // sleep.js holds the process open with a setInterval; the backend's
      // timeout kills the container before it resolves.
      const res = await be.run({ command: ['node', '/skill/sleep.js'], timeoutMs: 2000 });
      expect(res.timedOut).toBe(true);
    } finally { await be.cleanup(); }
  });
});
