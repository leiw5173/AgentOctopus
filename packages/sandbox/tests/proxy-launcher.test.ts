import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { DefaultProxyLauncher } from '../src/proxy/launcher.js';
import { buildDockerLaunchArgs, buildLinuxLaunchArgs } from '../src/proxy/launcher.js';
import type { SandboxPolicy } from '../src/policy.js';
import type { ResolvedSecrets } from '../src/proxy/egress-proxy.js';
import type { ProxyCarrier } from '../src/backend.js';

function makePolicy(): SandboxPolicy {
  return {
    hosts: ['127.0.0.1'],
    credentials: [],
    resources: { memoryBytes: 512 * 1024 * 1024, timeoutMs: 30000, cpus: 0.5 },
    denied: { hosts: [], credentials: [] },
  };
}

function makeSecrets(): ResolvedSecrets {
  return { api_key: 'sk-test-abc123' };
}

describe('DefaultProxyLauncher', () => {
  let tmp: string;

  beforeEach(() => {
    tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'launcher-test-'));
  });

  afterEach(() => {
    fs.rmSync(tmp, { recursive: true, force: true });
  });

  it('returns a reachableAddr based on reachableHost rather than listenHost', async () => {
    const carrier: Extract<ProxyCarrier, { kind: 'in-process' }> = {
      kind: 'in-process',
      listenHost: '127.0.0.1',
      reachableHost: 'proxy.internal',
    };
    const launcher = new DefaultProxyLauncher();
    const handle = await launcher.launch(
      { policy: makePolicy(), secrets: makeSecrets(), workDir: tmp },
      carrier,
    );
    expect(handle.reachableAddr).toMatch(/^http:\/\/proxy\.internal:\d+$/);
    expect(handle.reachableAddr).not.toContain('127.0.0.1');
    await handle.close();
  });

  it('returns a real caBundlePath and closes an in-process handle idempotently', async () => {
    const carrier: Extract<ProxyCarrier, { kind: 'in-process' }> = {
      kind: 'in-process',
      listenHost: '127.0.0.1',
      reachableHost: '127.0.0.1',
    };
    const launcher = new DefaultProxyLauncher();
    const handle = await launcher.launch(
      { policy: makePolicy(), secrets: makeSecrets(), workDir: tmp },
      carrier,
    );

    expect(handle.caBundlePath).toBe(path.join(tmp, 'ca.pem'));
    expect(fs.existsSync(handle.caBundlePath)).toBe(true);
    const content = fs.readFileSync(handle.caBundlePath, 'utf8');
    expect(content).toContain('BEGIN CERTIFICATE');

    // Idempotent close
    await handle.close();
    await handle.close();
  });

  it('builds Docker launch arguments with the internal network and sidecar alias', () => {
    const carrier: Extract<ProxyCarrier, { kind: 'docker-sidecar' }> = {
      kind: 'docker-sidecar',
      proxyImage: 'registry.example.com/proxy@sha256:abc123',
      internalNetwork: 'octopus-sbx-test-internal',
      egressNetwork: 'octopus-sbx-test-egress',
      reachableHost: 'egress-proxy',
    };
    const args = buildDockerLaunchArgs(carrier);
    expect(args).toContain('run');
    expect(args).toContain('--rm');
    expect(args).toContain('-i');
    expect(args).toContain('--network');
    expect(args).toContain('octopus-sbx-test-internal');
    expect(args).toContain('--network-alias');
    expect(args).toContain('egress-proxy');
    expect(args).toContain('registry.example.com/proxy@sha256:abc123');
    // No secret values in argv
    const joined = args.join(' ');
    expect(joined).not.toContain('sk-test-abc123');
    expect(joined).not.toContain('p@ssw0rd');
  });

  it('builds Linux-static launch arguments with the supplied namespace and cgroup', () => {
    const carrier: Extract<ProxyCarrier, { kind: 'linux-static' }> = {
      kind: 'linux-static',
      binaryPath: '/opt/octopus/egress-proxy-bundle.mjs',
      skillNamespace: { name: 'testns', path: '/var/run/netns/testns' },
      listenHost: '127.0.0.1',
      reachableHost: 'proxy.local',
      cgroupPath: '/sys/fs/cgroup/octopus/test',
      listenPort: 8080,
    };
    const args = buildLinuxLaunchArgs(carrier);
    expect(args).toContain('node');
    expect(args).toContain('/opt/octopus/egress-proxy-bundle.mjs');
    expect(args).toContain('127.0.0.1');
    expect(args).toContain('8080');
    expect(args).toContain('/var/run/netns/testns');
    expect(args).toContain('/sys/fs/cgroup/octopus/test');
    // No secret values in argv
    const joined = args.join(' ');
    expect(joined).not.toContain('sk-test-abc123');
  });
});
