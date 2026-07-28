/**
 * Plan 6 Task 2 — Docker lane isolation tests.
 *
 * The FIRST lane that exercises the REAL Docker backend against the REAL
 * pinned runtime image (`agentoctopus/skill-runtime` @ sha256) and the REAL
 * production egress-proxy sidecar. No fakes, no behavioral stand-ins: every
 * case drives the canonical orchestration order (selectBackend →
 * prepareTopology → DefaultProxyLauncher.launch → verifySnapshot → prepare →
 * run/spawn) and asserts an EXTERNALLY OBSERVABLE invariant:
 *
 *   - exact argv survives (the runtime image has no entrypoint to mangle it),
 *   - a unique, unmounted host canary is neither readable nor writable,
 *   - direct internet + cloud metadata are unreachable without the proxy,
 *   - host/credential env vars never leak into the guest,
 *   - combined stdout/stderr is capped, reported separately from timeout,
 *   - a timeout destroys the WHOLE container, reaping a detached grandchild,
 *   - cgroup + hardening settings (memory/cpu/pids/ro-rootfs/cap-drop/nnp).
 *
 * Requires OCTOPUS_TEST_RUNTIME_IMAGE + OCTOPUS_TEST_PROXY_IMAGE (immutable
 * local image IDs from `docker image inspect --format '{{.Id}}'`), validated by
 * the Task 1 harness gate. Gated on a REAL Docker daemon via probeDocker.
 *
 * Leaf-clean: Node stdlib + this package's own src + the Task 1 harness.
 */

import { readFileSync } from 'node:fs';
import { describe, it, expect, beforeAll } from 'vitest';
import { runDocker } from '../../src/docker/cli.js';
import { createHostCanary, probeDocker } from './harness.js';
import { setupDockerSandbox, runProbe, type ProbeResult } from './docker-lane-setup.js';

// Re-export so the shared helper is available from this module (per the brief,
// runProbe lives in docker-lane.test.ts) while remaining importable elsewhere.
export { runProbe } from './docker-lane-setup.js';

const RUN_TIMEOUT = 120_000;

let dockerAvailable = false;
beforeAll(async () => {
  dockerAvailable = (await probeDocker()).available;
});

/** Skip helper: every case requires a real daemon and both pinned images. */
function needDocker(ctx: unknown): boolean {
  if (!dockerAvailable) { (ctx as { skip: () => void }).skip(); return false; }
  return true;
}

// ---------------------------------------------------------------------------
// Long-running probe helpers (spawn-based so we can inspect mid-flight).
// ---------------------------------------------------------------------------

interface RunningProbe {
  containerName: string;
  result: Promise<ProbeResult>;
  /** Poll `docker top` until the parent + grandchild are both visible. */
  waitForGrandchildReady(): Promise<void>;
  cleanup(): Promise<void>;
}

/** Start the process-tree probe with a short timeout; inspect before the kill. */
async function startProcessTreeProbe(input: { timeoutMs: number }): Promise<RunningProbe> {
  const sandbox = await setupDockerSandbox();
  const proc = await sandbox.backend.spawn({
    command: ['node', '/skill/probe.js'],
    env: { PROBE_ACTION: 'process-tree' },
    timeoutMs: input.timeoutMs,
  });
  const containerName = sandbox.runtimeContainerName;

  const result = (async (): Promise<ProbeResult> => {
    const r = await proc.exited;
    return { ...r, json: {} };
  })();

  return {
    containerName,
    result,
    waitForGrandchildReady: async () => {
      const deadline = Date.now() + 10_000;
      for (;;) {
        const top = await runDocker(['top', containerName, '-eo', 'pid,ppid,comm']);
        // header + parent node + grandchild node => at least 3 lines, 2 node procs
        const nodeCount = (top.stdout.match(/node/g) ?? []).length;
        if (top.code === 0 && nodeCount >= 2) return;
        if (Date.now() > deadline) return; // proceed; assertion below decides
        await new Promise((r) => setTimeout(r, 100));
      }
    },
    cleanup: async () => {
      await proc.close().catch(() => {});
      await sandbox.cleanup();
    },
  };
}

/** Start a blocking probe that stays up until cleaned up (for inspect). */
async function startBlockingProbe(): Promise<{ containerName: string; cleanup(): Promise<void> }> {
  const sandbox = await setupDockerSandbox({ timeoutMs: 60_000 });
  const proc = await sandbox.backend.spawn({
    command: ['node', '/skill/probe.js'],
    env: { PROBE_ACTION: 'block' },
    timeoutMs: 60_000,
  });
  const containerName = sandbox.runtimeContainerName;
  // Wait until the container exists and is running.
  const deadline = Date.now() + 15_000;
  for (;;) {
    const ps = await runDocker(['ps', '-q', '--filter', `name=${containerName}`]);
    if (ps.stdout.trim().length > 0) break;
    if (Date.now() > deadline) throw new Error('blocking probe container did not start');
    await new Promise((r) => setTimeout(r, 100));
  }
  return {
    containerName,
    cleanup: async () => {
      await proc.close().catch(() => {});
      await sandbox.cleanup();
    },
  };
}

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

describe('Docker lane — isolation', () => {
  it('uses the exact command argv with no image entrypoint mangling', async (ctx) => {
    if (!needDocker(ctx)) return;
    const result = await runProbe('argv', { command: ['node', '/skill/probe.js', 'alpha', 'two words'] });
    expect(result.exitCode).toBe(0);
    expect(result.json.argv).toEqual(['alpha', 'two words']);
  }, RUN_TIMEOUT);

  it('cannot read or overwrite a unique host canary that was not mounted', async (ctx) => {
    if (!needDocker(ctx)) return;
    const canary = createHostCanary();
    try {
      const read = await runProbe('host-canary-read', { env: { HOST_CANARY_PATH: canary.containerPath } });
      const write = await runProbe('host-canary-write', { env: { HOST_CANARY_PATH: canary.containerPath } });
      expect(read.json.ok).toBe(false);
      expect(write.json.ok).toBe(false);
      // The host canary is untouched — neither path nor content leaked.
      expect(readFileSync(canary.hostPath, 'utf8')).toBe(canary.content);
    } finally {
      canary.cleanup();
    }
  }, RUN_TIMEOUT);

  it.each(['direct-internet', 'metadata'])('%s is unreachable without the proxy', async (action, ctx) => {
    if (!needDocker(ctx)) return;
    const result = await runProbe(action);
    expect(result.json.ok).toBe(false);
  }, RUN_TIMEOUT);

  it('does not expose host or credential environment variables', async (ctx) => {
    if (!needDocker(ctx)) return;
    process.env.OCTOPUS_HOST_SECRET_CANARY = 'host-only-value';
    try {
      const result = await runProbe('env-names');
      expect(result.json.names).not.toContain('OCTOPUS_HOST_SECRET_CANARY');
      expect(result.stdout).not.toContain('host-only-value');
    } finally {
      delete process.env.OCTOPUS_HOST_SECRET_CANARY;
    }
  }, RUN_TIMEOUT);

  it('caps combined stdout/stderr and reports output overflow separately from timeout', async (ctx) => {
    if (!needDocker(ctx)) return;
    const result = await runProbe('output-flood', { outputMaxBytes: 32_768 });
    expect(Buffer.byteLength(result.stdout) + Buffer.byteLength(result.stderr)).toBeLessThanOrEqual(33_024);
    expect(result.timedOut).toBe(false);
    expect(result.stderr).toContain('outputMaxBytes');
  }, RUN_TIMEOUT);

  it('times out, destroys the container, and reaps the grandchild', async (ctx) => {
    if (!needDocker(ctx)) return;
    const running = await startProcessTreeProbe({ timeoutMs: 500 });
    try {
      await running.waitForGrandchildReady();
      const before = await runDocker(['top', running.containerName, '-eo', 'pid,ppid,comm']);
      expect(before.stdout).toMatch(/node/);
      // header + parent node + grandchild node
      expect(before.stdout.trim().split('\n').length).toBeGreaterThanOrEqual(3);
      const result = await running.result;
      expect(result.timedOut).toBe(true);
      // The timeout path issues `docker rm -f` without awaiting it, so poll for
      // the container (and its reaped grandchild) to actually disappear rather
      // than asserting on a fixed instant. Destruction must complete promptly.
      const deadline = Date.now() + 10_000;
      let listing = '';
      for (;;) {
        listing = (await runDocker(['ps', '-aq', '--filter', `name=${running.containerName}`])).stdout.trim();
        if (listing === '') break;
        if (Date.now() > deadline) break;
        await new Promise((r) => setTimeout(r, 100));
      }
      expect(listing).toBe('');
    } finally {
      await running.cleanup();
    }
  }, RUN_TIMEOUT);

  it('applies memory, CPU, PID, read-only-rootfs, cap-drop, and no-new-privileges settings', async (ctx) => {
    if (!needDocker(ctx)) return;
    const running = await startBlockingProbe();
    try {
      const inspect = JSON.parse((await runDocker(['inspect', running.containerName])).stdout)[0];
      expect(inspect.HostConfig.ReadonlyRootfs).toBe(true);
      expect(inspect.HostConfig.CapDrop).toContain('ALL');
      expect(inspect.HostConfig.SecurityOpt).toContain('no-new-privileges');
      expect(inspect.HostConfig.Memory).toBeGreaterThan(0);
      expect(inspect.HostConfig.NanoCpus).toBeGreaterThan(0);
      expect(inspect.HostConfig.PidsLimit).toBeGreaterThan(0);
    } finally {
      await running.cleanup();
    }
  }, RUN_TIMEOUT);
});
