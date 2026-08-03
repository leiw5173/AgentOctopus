/**
 * Plan 6 Task 2 — Docker sidecar topology tests.
 *
 * Exercises the REAL network topology the Docker backend builds:
 *
 *   - the RUNTIME container joins ONLY the --internal network (no route off-box),
 *   - the egress-proxy SIDECAR is dual-homed: internal (reachable by the
 *     runtime via its alias) + egress (the only path to an upstream),
 *   - the session CA bundle is mounted READ-ONLY at the runtime contract path
 *     /etc/skill-ca/ca.pem.
 *
 * The egress assertion is behavioral, not just structural: an upstream fixture
 * is started on the egress network with a static IP, that exact IP literal is
 * granted, and the runtime issues an ABSOLUTE-FORM request through the proxy to
 * the granted upstream, proving the only working egress path is via the proxy.
 *
 * Requires a REAL Docker daemon + both pinned images. Leaf-clean.
 */

import { describe, it, expect, beforeAll } from 'vitest';
import { runDocker } from '../../src/docker/cli.js';
import { probeDockerImages } from './harness.js';
import { setupDockerSandbox, type DockerSandbox } from './docker-lane-setup.js';
import { startEgressUpstream } from './egress-upstream.js';

const RUN_TIMEOUT = 180_000;

let dockerAvailable = false;
beforeAll(async () => {
  // Stricter than probeDocker: every case runs the actual runtime and proxy
  // images. setupDockerSandbox REQUIRES immutable digest refs via env
  // (requirePinnedImageRef — SandboxConfigSchema rejects mutable tags), so
  // both env refs must be set AND the images present locally (security:images
  // built them). On a plain runner the daemon may be reachable via hello-world
  // while the trusted images are absent — docker run would exit 125 spuriously.
  //
  // Skip the probe entirely when the immutable env refs are absent (see
  // docker-lane.test.ts) — a plain ci.yml runner would otherwise pull
  // hello-world over a restricted network and blow vitest's 10s hookTimeout.
  if (!process.env.OCTOPUS_TEST_RUNTIME_IMAGE || !process.env.OCTOPUS_TEST_PROXY_IMAGE) return;
  dockerAvailable = (await probeDockerImages([
    process.env.OCTOPUS_TEST_RUNTIME_IMAGE,
    process.env.OCTOPUS_TEST_PROXY_IMAGE,
  ])).available;
});

function needDocker(ctx: unknown): boolean {
  if (!dockerAvailable) { (ctx as { skip: () => void }).skip(); return false; }
  return true;
}

interface DockerTopology {
  internalNetwork: string;
  egressNetwork: string;
  /** Full container IDs as they appear as keys under network inspect .Containers. */
  runtimeId: string;
  proxyId: string;
  /** The runtime container NAME (stable handle for docker inspect/exec). */
  runtimeName: string;
  proxy: { reachableAddr: string };
  /** Absolute URL of the granted upstream (http://<static-ip>/). */
  grantedUpstreamUrl: string;
  /** Run a command inside the running runtime container (docker exec). */
  execRuntime(argv: string[]): Promise<{ exitCode: number; stdout: string; stderr: string }>;
  cleanup(): Promise<void>;
}

/** Find a free static IPv4 address inside a network's first subnet. */
async function startTopologyUpstream(egressNetwork: string): Promise<{ name: string; ip: string }> {
  return startEgressUpstream(egressNetwork);
}

async function startDockerTopology(): Promise<DockerTopology> {
  let upstreamName = '';
  let upstreamIp = '';
  let grantedUpstreamUrl = '';

  const sandbox: DockerSandbox = await setupDockerSandbox({
    afterTopology: async ({ egressNetwork }) => {
      const up = await startTopologyUpstream(egressNetwork);
      upstreamName = up.name;
      upstreamIp = up.ip;
      grantedUpstreamUrl = `http://${up.ip}/`;
      return [up.ip]; // grant the exact egress-network IP literal (allows private literal)
    },
  });

  // Spawn a long-running runtime container so it appears under network inspect.
  const proc = await sandbox.backend.spawn({
    command: ['node', '/skill/probe.js'],
    env: { PROBE_ACTION: 'block' },
    timeoutMs: 120_000,
  });
  const runtimeName = sandbox.runtimeContainerName;

  // Wait for the runtime + proxy to be attached, then resolve their CANONICAL
  // container IDs via `docker inspect <name>`. The network inspect .Containers
  // map can transiently key an endpoint (ep-…) while a dual-homed sidecar is
  // being attached to its second network, so we key on the container NAME and
  // resolve the ID from the container itself — the same ID network inspect
  // settles on once attachment completes.
  const deadline = Date.now() + 20_000;
  let runtimeId = '';
  let proxyId = '';
  for (;;) {
    const internal = JSON.parse((await runDocker(['network', 'inspect', sandbox.internalNetwork])).stdout)[0];
    const containers: Record<string, { Name: string }> = internal.Containers ?? {};
    const names = Object.values(containers).map((c) => c.Name);
    const proxyName = names.find((n) => n.startsWith('octopus-proxy-'));
    const runtimePresent = names.includes(runtimeName);
    if (proxyName && runtimePresent) {
      const rid = (await runDocker(['inspect', '--format', '{{.Id}}', runtimeName])).stdout.trim();
      const pid = (await runDocker(['inspect', '--format', '{{.Id}}', proxyName])).stdout.trim();
      if (rid && pid) { runtimeId = rid; proxyId = pid; break; }
    }
    if (Date.now() > deadline) {
      await proc.close().catch(() => {});
      if (upstreamName) await runDocker(['rm', '-f', upstreamName]).catch(() => {});
      await sandbox.cleanup();
      throw new Error(`runtime/proxy containers not visible on internal network (runtimeId=${runtimeId || '?'} proxyId=${proxyId || '?'})`);
    }
    await new Promise((r) => setTimeout(r, 150));
  }

  return {
    internalNetwork: sandbox.internalNetwork,
    egressNetwork: sandbox.egressNetwork,
    runtimeId,
    proxyId,
    runtimeName,
    proxy: { reachableAddr: sandbox.proxy.reachableAddr },
    grantedUpstreamUrl,
    execRuntime: async (argv) => {
      const res = await runDocker(['exec', runtimeName, ...argv]);
      return { exitCode: res.code, stdout: res.stdout, stderr: res.stderr };
    },
    cleanup: async () => {
      await proc.close().catch(() => {});
      if (upstreamName) await runDocker(['rm', '-f', upstreamName]).catch(() => {});
      await sandbox.cleanup();
    },
  };
}

describe('Docker lane — sidecar topology', () => {
  it('puts runtime only on the internal network and dual-homes the proxy sidecar', async (ctx) => {
    if (!needDocker(ctx)) return;
    const topo = await startDockerTopology();
    try {
      const internal = JSON.parse((await runDocker(['network', 'inspect', topo.internalNetwork])).stdout)[0];
      const egress = JSON.parse((await runDocker(['network', 'inspect', topo.egressNetwork])).stdout)[0];

      expect(internal.Internal).toBe(true);
      expect(Object.keys(internal.Containers)).toEqual(expect.arrayContaining([topo.runtimeId, topo.proxyId]));
      expect(Object.keys(egress.Containers)).toContain(topo.proxyId);
      expect(Object.keys(egress.Containers)).not.toContain(topo.runtimeId);

      // Behavioral egress: the runtime reaches the granted upstream ONLY via
      // the proxy (absolute-form request to the dual-homed sidecar).
      const result = await topo.execRuntime(['node', '/skill/http-probe.js', topo.proxy.reachableAddr, topo.grantedUpstreamUrl]);
      expect(result.exitCode).toBe(0);
      expect(result.stdout).toContain('ok');
    } finally {
      await topo.cleanup();
    }
  }, RUN_TIMEOUT);

  it('mounts the session CA read-only at the runtime contract path', async (ctx) => {
    if (!needDocker(ctx)) return;
    const topo = await startDockerTopology();
    try {
      const inspect = JSON.parse((await runDocker(['inspect', topo.runtimeName])).stdout)[0];
      expect(inspect.Mounts).toEqual(expect.arrayContaining([
        expect.objectContaining({ Destination: '/etc/skill-ca/ca.pem', RW: false }),
      ]));
    } finally {
      await topo.cleanup();
    }
  }, RUN_TIMEOUT);
});
