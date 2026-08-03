/**
 * Plan 6 — Docker egress NETWORKING behavior contract.
 *
 * Stands up the REAL internal+egress topology with the proxy sidecar (the same
 * harness as docker-topology.test.ts), then runs the runtime guest's BUILT-IN
 * fetch — routed through the egress proxy only because the backend injects
 * NODE_OPTIONS=--require /opt/octopus-boot/bootstrap.cjs plus HTTPS_PROXY — and
 * asserts the grant gate still decides egress:
 *
 *   - granted host:   fetch returns real upstream data, with NO EAI_AGAIN
 *                     (proving the bootstrap routed fetch to the proxy, not a
 *                     silent direct path — guest DNS is cut, so a direct attempt
 *                     would fail closed with EAI_AGAIN).
 *   - ungranted host: the proxy rejects at the egress layer with 403 and a body
 *                     containing "host not granted" (fail-closed preserved).
 *
 * Requires a REAL Docker daemon + both pinned images (probeDockerImages-gated);
 * exercised in the hosted-docker-proxy security lane.
 */

import { describe, it, expect, beforeAll } from 'vitest';
import { runDocker } from '../../src/docker/cli.js';
import { probeDockerImages } from './harness.js';
import { setupDockerSandbox, type DockerSandbox } from './docker-lane-setup.js';
import { startEgressUpstream } from './egress-upstream.js';
import { FETCH_PROBE_REL } from './lane-probe.js';

const RUN_TIMEOUT = 180_000;

let dockerAvailable = false;
beforeAll(async () => {
  // Same gating as docker-topology: setupDockerSandbox REQUIRES immutable digest
  // refs via env (requirePinnedImageRef), so skip the probe entirely when the
  // env refs are absent (a plain ci.yml runner would otherwise pull over a
  // restricted network and blow vitest's 10s hookTimeout).
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

interface FetchOut { status: number; body: string; error: string | null; causeCode?: string | null }

/**
 * Run the runtime guest's built-in fetch against `url` through the full sandbox.
 * The backend run injects HTTPS_PROXY + NODE_OPTIONS bootstrap, so the guest's
 * fetch traverses the egress proxy exactly as a real skill's would.
 */
async function fetchThroughSandbox(
  sandbox: DockerSandbox,
  url: string,
): Promise<FetchOut> {
  const result = await sandbox.backend.run({
    command: ['node', `/skill/${FETCH_PROBE_REL}`, url],
    env: {},
    timeoutMs: 30_000,
  });
  const line = result.stdout.split('\n').map((l) => l.trim()).find((l) => l.startsWith('{'));
  if (!line) {
    throw new Error(`fetch probe emitted no JSON (exit=${result.exitCode} stderr=${result.stderr.trim()} stdout=${result.stdout.trim()})`);
  }
  const parsed = JSON.parse(line) as FetchOut;
  if (parsed.error) {
    // Surface the full probe result + guest stderr to make bootstrap/proxy
    // failures diagnosable from the test output.
    throw new Error(`fetch probe error: ${JSON.stringify(parsed)} guest-stderr=${result.stderr.trim()}`);
  }
  return parsed;
}

/** Build the sandbox + sidecar + granted upstream, returning handles for teardown. */
async function startTopology(): Promise<{
  sandbox: DockerSandbox;
  upstreamName: string;
  grantedUrl: string;
}> {
  let upstreamName = '';
  let grantedUrl = '';
  const sandbox = await setupDockerSandbox({
    afterTopology: async ({ egressNetwork }) => {
      const up = await startEgressUpstream(egressNetwork);
      upstreamName = up.name;
      grantedUrl = `http://${up.ip}/`;
      return [up.ip]; // grant the exact egress-network IP literal
    },
  });
  return { sandbox, upstreamName, grantedUrl };
}

describe('docker egress networking (bootstrap routes fetch; grant gates egress)', () => {
  it('granted host routes through proxy and returns data (no EAI_AGAIN)', async (ctx) => {
    if (!needDocker(ctx)) return;
    const { sandbox, upstreamName, grantedUrl } = await startTopology();
    try {
      const out = await fetchThroughSandbox(sandbox, grantedUrl);
      // Real data came back through the proxy …
      expect(out.error).toBeNull();
      expect(out.status).toBe(200);
      expect(out.body).toContain('ok');
      // … and it was NOT a silent direct path: guest DNS is cut, so any direct
      // attempt would have surfaced EAI_AGAIN. Assert it is absent.
      expect(out.error ?? '').not.toContain('EAI_AGAIN');
      expect(sandbox.policy.hosts).toContain(new URL(grantedUrl).hostname);
    } finally {
      // Remove the upstream fixture BEFORE tearing the sandbox down so its
      // endpoint is gone when the backend removes the egress network.
      if (upstreamName) await runDocker(['rm', '-f', upstreamName]).catch(() => {});
      await sandbox.cleanup();
    }
  }, RUN_TIMEOUT);

  it('ungranted host is rejected at the egress layer with 403 host not granted', async (ctx) => {
    if (!needDocker(ctx)) return;
    const { sandbox, upstreamName } = await startTopology();
    try {
      // example.com is NOT in the grant set (only the upstream's egress IP is).
      // The proxy's policy engine denies it before any upstream connection.
      const out = await fetchThroughSandbox(sandbox, 'http://example.com/');
      expect(out.status).toBe(403);
      expect(out.body).toContain('host not granted');
      // No direct route either: the rejection came from the PROXY (403), not a
      // guest-side DNS failure — proving egress fails closed at the proxy.
      expect(out.error ?? '').not.toContain('EAI_AGAIN');
    } finally {
      if (upstreamName) await runDocker(['rm', '-f', upstreamName]).catch(() => {});
      await sandbox.cleanup();
    }
  }, RUN_TIMEOUT);
});
