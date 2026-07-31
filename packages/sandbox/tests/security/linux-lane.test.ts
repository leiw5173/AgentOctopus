/**
 * Plan 6 Task 6 — privileged Linux lane isolation tests.
 *
 * The FIRST lane that exercises the REAL `OsSandboxBackend` against the REAL
 * reviewed Linux runtime artifact (`linux-node22`) and the REAL externally-
 * launched egress proxy. No fakes, no injected deps, no behavioral stand-ins:
 * every case drives the canonical orchestration order (selectBackend →
 * prepareTopology → DefaultProxyLauncher.launch → verifySnapshot → prepare →
 * run/spawn) and asserts an EXTERNALLY OBSERVABLE invariant:
 *
 *   - a unique, unmounted host canary is neither readable nor writable,
 *   - direct internet + cloud metadata are unreachable (nft default-drop),
 *   - an ungranted host is refused by the proxy even when requested,
 *   - host/credential env vars never leak into the sandboxed process,
 *   - combined stdout/stderr is capped, reported separately from timeout,
 *   - a timeout kills the WHOLE cgroup (observed via skillCgroupPath +
 *     cgroup.events populated 0), reaping a detached grandchild,
 *   - cgroup memory/pids/cpu limits are finite and read back from the kernel,
 *   - the trusted PID ceiling is exactly 64 (production constant, no schema
 *     pids field) and a fork-bomb cannot exceed it,
 *   - a cgroup that cannot be created prevents the spawn (fail-closed).
 *
 * Action delivery: the OS helper clears the environment and installs only a
 * tiny SAFE allowlist (see buildAllowlistedEnv in src/os/run-spec.ts), so the
 * probe action and any probe arguments are passed as ARGV (`node
 * /skill/probe.js <action> [args]`), never via env. Any remaining env use in
 * the probe is a Docker-lane compatibility path that degrades to a closed
 * default when the env var is absent.
 *
 * Gating (M6): `OCTOPUS_REQUIRE_PRIVILEGED_LINUX=1` makes unavailable
 * capabilities FATAL (throw in beforeAll — never a skip). Otherwise each case
 * skips when the capability is absent (macOS dev hosts). Skipping here is NOT
 * evidence of privileged coverage; the mandatory CI privileged lane runs with
 * the require gate set and asserts zero skips.
 *
 * Leaf-clean: Node stdlib + this package's own src + the Task 1 harness.
 */

import { readFileSync } from 'node:fs';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { describe, it, expect, beforeAll } from 'vitest';
import { createHostCanary } from './harness.js';
import {
  linuxLaneAvailability,
  needPrivilegedLinux,
  setupLinuxSandbox,
  runLinuxProbe,
  execInNetns,
  parseProbeJson,
  type LinuxSandbox,
} from './linux-lane-setup.js';

const execFileAsync = promisify(execFile);

const RUN_TIMEOUT = 120_000;

let laneAvailable = false;
beforeAll(async () => {
  // Throws when OCTOPUS_REQUIRE_PRIVILEGED_LINUX=1 and the capability is
  // unavailable — the mandatory lane must never silently skip.
  laneAvailable = (await linuxLaneAvailability()).available;
});

function needLinux(ctx: unknown): boolean {
  return needPrivilegedLinux(ctx, laneAvailable);
}

// ---------------------------------------------------------------------------
// Cgroup observation helpers (argv-only, host-side, read-only).
// ---------------------------------------------------------------------------

async function readCgroupFile(path: string): Promise<string> {
  const { stdout } = await execFileAsync('cat', [path]);
  return stdout.trim();
}

/** Poll cgroup.events until `populated 0` or the deadline passes. Returns the last content. */
async function waitCgroupEmpty(cgroupPath: string, timeoutMs: number): Promise<string> {
  const deadline = Date.now() + timeoutMs;
  let last = '';
  for (;;) {
    try {
      last = await readCgroupFile(`${cgroupPath}/cgroup.events`);
      if (/^populated 0$/m.test(last)) return last;
    } catch {
      return '<unreadable>'; // cgroup removed — treat as empty
    }
    if (Date.now() > deadline) return last;
    await new Promise((r) => setTimeout(r, 50));
  }
}

// ---------------------------------------------------------------------------
// Long-running probe helpers (spawn-based so we can inspect mid-flight).
// ---------------------------------------------------------------------------

interface RunningLinuxProbe {
  sandbox: LinuxSandbox;
  /** The skill cgroup path captured while the process is running. */
  cgroupPath: string;
  result: Promise<{ exitCode: number; stdout: string; stderr: string; timedOut: boolean }>;
  cleanup(): Promise<void>;
}

/** Start the process-tree probe with a short timeout; observe the cgroup before the kill. */
async function startProcessTreeProbe(input: { timeoutMs: number }): Promise<RunningLinuxProbe> {
  const sandbox = await setupLinuxSandbox({ timeoutMs: 60_000 });
  const proc = await sandbox.backend.spawn({
    command: ['/usr/bin/node', '/skill/probe.js', 'process-tree'],
    timeoutMs: input.timeoutMs,
  });
  const cgroupPath = sandbox.skillCgroupPath;
  if (!cgroupPath) {
    await proc.close().catch(() => {});
    await sandbox.cleanup();
    throw new Error('skillCgroupPath is undefined after prepare — the concrete getter contract broke');
  }
  return {
    sandbox,
    cgroupPath,
    result: (async () => {
      const r = await proc.exited;
      return { exitCode: r.exitCode, stdout: r.stdout, stderr: r.stderr, timedOut: r.timedOut };
    })(),
    cleanup: async () => {
      await proc.close().catch(() => {});
      await sandbox.cleanup();
    },
  };
}

/** Start a blocking probe that stays up until cleaned up (for cgroup limit assertions). */
async function startBlockingProbe(): Promise<RunningLinuxProbe> {
  const sandbox = await setupLinuxSandbox({ timeoutMs: 60_000 });
  const proc = await sandbox.backend.spawn({
    command: ['/usr/bin/node', '/skill/probe.js', 'block'],
    timeoutMs: 60_000,
  });
  const cgroupPath = sandbox.skillCgroupPath;
  if (!cgroupPath) {
    await proc.close().catch(() => {});
    await sandbox.cleanup();
    throw new Error('skillCgroupPath is undefined after prepare — the concrete getter contract broke');
  }
  // Wait until the cgroup is populated (the helper has been attached).
  const deadline = Date.now() + 15_000;
  for (;;) {
    let populated = false;
    try {
      const events = await readCgroupFile(`${cgroupPath}/cgroup.events`);
      populated = /^populated 1$/m.test(events);
    } catch { /* not yet */ }
    if (populated) break;
    if (Date.now() > deadline) {
      await proc.close().catch(() => {});
      await sandbox.cleanup();
      throw new Error('skill cgroup did not become populated');
    }
    await new Promise((r) => setTimeout(r, 50));
  }
  return {
    sandbox,
    cgroupPath,
    result: (async () => {
      const r = await proc.exited;
      return { exitCode: r.exitCode, stdout: r.stdout, stderr: r.stderr, timedOut: r.timedOut };
    })(),
    cleanup: async () => {
      await proc.close().catch(() => {});
      await sandbox.cleanup();
    },
  };
}

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

describe('Linux lane — isolation', () => {
  it('uses the exact command argv with no helper-side mangling', async (ctx) => {
    if (!needLinux(ctx)) return;
    // OS lane strips env, so the action MUST ride argv[2] (see lane-probe.ts:
    // `action = process.env.PROBE_ACTION ?? process.argv[2]`, and the OS helper
    // clears env). The Docker lane passes the action via PROBE_ACTION env and
    // puts only the payload in argv; the OS lane cannot, so the action token
    // 'argv' is part of the emitted slice(2). This is the documented contract,
    // not mangling: process.argv.slice(2) reports EVERY arg including the action.
    const result = await runLinuxProbe('argv', { command: ['/usr/bin/node', '/skill/probe.js', 'argv', 'alpha', 'two words'] });
    expect(result.exitCode).toBe(0);
    expect(result.json.argv).toEqual(['argv', 'alpha', 'two words']);
  }, RUN_TIMEOUT);

  it('cannot read or overwrite a unique host canary that was not mounted', async (ctx) => {
    if (!needLinux(ctx)) return;
    const canary = createHostCanary();
    try {
      // The canary path is a HOST path; inside the chrooted runtime it is
      // simply absent (the runtime root is the verified artifact tree, and
      // only /skill + /etc/skill-ca/ca.pem are bind-mounted).
      const read = await runLinuxProbe('host-canary-read');
      const write = await runLinuxProbe('host-canary-write');
      expect(read.json.ok).toBe(false);
      expect(write.json.ok).toBe(false);
      // Under the OS backend the probe never even receives the host canary
      // path (env is stripped) — envPath:false records that closed default.
      expect(read.json.envPath).toBe(false);
      expect(write.json.envPath).toBe(false);
      // The host canary is untouched — neither path nor content leaked.
      expect(readFileSync(canary.hostPath, 'utf8')).toBe(canary.content);
    } finally {
      canary.cleanup();
    }
  }, RUN_TIMEOUT);

  it('direct-internet is unreachable behind the nft default-drop', async (ctx) => {
    if (!needLinux(ctx)) return;
    const result = await runLinuxProbe('net-probe', { extraArgs: ['example.com', '80'] });
    expect(result.json.ok).toBe(false);
  }, RUN_TIMEOUT);

  it('metadata is unreachable behind the nft default-drop', async (ctx) => {
    if (!needLinux(ctx)) return;
    const result = await runLinuxProbe('net-probe', { extraArgs: ['169.254.169.254', '80'] });
    expect(result.json.ok).toBe(false);
  }, RUN_TIMEOUT);

  it('refuses an ungranted upstream through the proxy (deny-all policy holds)', async (ctx) => {
    if (!needLinux(ctx)) return;
    // Request a host but grant NOTHING: requested ∩ granted is empty, so the
    // proxy must deny the request even though the skill asked for it. The
    // http probe issues an absolute-form request through the in-netns proxy;
    // a non-2xx (proxy 4xx deny) proves the policy held.
    const sandbox = await setupLinuxSandbox({ request: { hosts: ['169.254.169.254'] } });
    try {
      const result = await sandbox.backend.run({
        command: ['/usr/bin/node', '/skill/http-probe.js', sandbox.proxy.reachableAddr, 'http://169.254.169.254/'],
        timeoutMs: 30_000,
      });
      expect(result.exitCode).not.toBe(0);
      expect(result.stdout).not.toContain('ok');
    } finally {
      await sandbox.cleanup();
    }
  }, RUN_TIMEOUT);

  it('does not expose host or credential environment variables', async (ctx) => {
    if (!needLinux(ctx)) return;
    process.env.OCTOPUS_HOST_SECRET_CANARY = 'host-only-value';
    try {
      const result = await runLinuxProbe('env-names');
      const names = (result.json.names as string[] | undefined) ?? [];
      expect(names).not.toContain('OCTOPUS_HOST_SECRET_CANARY');
      // The helper clears the environment and installs only the SAFE
      // allowlist, so the host canary can never reach the sandboxed process.
      expect(result.stdout).not.toContain('host-only-value');
    } finally {
      delete process.env.OCTOPUS_HOST_SECRET_CANARY;
    }
  }, RUN_TIMEOUT);

  it('caps combined stdout/stderr and reports output overflow separately from timeout', async (ctx) => {
    if (!needLinux(ctx)) return;
    const result = await runLinuxProbe('output-flood', { outputMaxBytes: 32_768 });
    expect(Buffer.byteLength(result.stdout) + Buffer.byteLength(result.stderr)).toBeLessThanOrEqual(33_024);
    expect(result.timedOut).toBe(false);
    expect(result.stderr).toContain('outputMaxBytes');
    // Output overflow is a containment event; the cgroup kill must have
    // succeeded, so the meta claims full (never degraded).
  }, RUN_TIMEOUT);

  it('times out, kills the whole cgroup, and reaps the grandchild', async (ctx) => {
    if (!needLinux(ctx)) return;
    const running = await startProcessTreeProbe({ timeoutMs: 500 });
    try {
      // Before the timeout fires, the cgroup must be populated with the
      // helper + skill process (and the detached grandchild).
      const before = await readCgroupFile(`${running.cgroupPath}/cgroup.events`);
      expect(before).toMatch(/^populated 1$/m);
      const procsBefore = await readCgroupFile(`${running.cgroupPath}/cgroup.procs`);
      expect(procsBefore.split('\n').filter(Boolean).length).toBeGreaterThanOrEqual(1);

      const result = await running.result;
      expect(result.timedOut).toBe(true);

      // The timeout path writes cgroup.kill; the kernel then kills EVERY
      // process in the cgroup (helper, skill node, detached grandchild).
      // Poll cgroup.events until populated 0 — destruction must complete
      // promptly, proving the process tree was reaped.
      const events = await waitCgroupEmpty(running.cgroupPath, 10_000);
      expect(events).toMatch(/^populated 0$/m);
    } finally {
      await running.cleanup();
    }
  }, RUN_TIMEOUT);

  it('writes finite memory/pids/cpu limits and reads them back from the kernel', async (ctx) => {
    if (!needLinux(ctx)) return;
    const running = await startBlockingProbe();
    try {
      const memMax = await readCgroupFile(`${running.cgroupPath}/memory.max`);
      const swapMax = await readCgroupFile(`${running.cgroupPath}/memory.swap.max`);
      const pidsMax = await readCgroupFile(`${running.cgroupPath}/pids.max`);
      const cpuMax = await readCgroupFile(`${running.cgroupPath}/cpu.max`);

      // Finite limits — never `max` (unbounded).
      expect(memMax).toMatch(/^\d+$/);
      expect(Number(memMax)).toBeGreaterThan(0);
      expect(swapMax).toBe('0');
      // M7: the trusted PID ceiling is exactly the production constant 64.
      // There is no schema pids field; it is never skill-influenced.
      expect(pidsMax).toBe('64');
      expect(cpuMax).toMatch(/^\d+ \d+$/);
    } finally {
      await running.cleanup();
    }
  }, RUN_TIMEOUT);

  it('enforces the pids.max=64 ceiling against a fork-bomb (M7)', async (ctx) => {
    if (!needLinux(ctx)) return;
    // The probe spawns Node children until fork fails. With pids.max=64 the
    // kernel refuses fork past the ceiling (EAGAIN), so the number of
    // successful spawns is bounded well below the 200-attempt loop. The
    // probe emits ok=false if it managed MORE than 63 spawns.
    const sandbox = await setupLinuxSandbox({ timeoutMs: 30_000 });
    try {
      const result = await sandbox.backend.run({
        command: ['/usr/bin/node', '/skill/probe.js', 'pids-flood'],
        timeoutMs: 30_000,
      });
      const json = parseProbeJson(result.stdout);
      expect(json.ok).toBe(true);
      // EAGAIN is the expected failure mode once the ceiling is hit.
      if (typeof json.spawned === 'number' && json.spawned >= 63) {
        expect(json.failErr).toBe('EAGAIN');
      }
    } finally {
      await sandbox.cleanup();
    }
  }, RUN_TIMEOUT);

  it('never spawns when the skill cgroup cannot be created (fail-closed)', async (ctx) => {
    if (!needLinux(ctx)) return;
    // Point the delegated cgroup root at a nonexistent directory. prepare()
    // validates the root fail-closed (must exist and be a directory) BEFORE
    // createLimitedCgroup runs, so it must throw — and no helper process may
    // ever be spawned. This is the Task 5 delegated-root gate exercised
    // against the real backend.
    const saved = process.env.OCTOPUS_TEST_CGROUP_PARENT;
    process.env.OCTOPUS_TEST_CGROUP_PARENT = '/sys/fs/cgroup/octopus-nonexistent-root-zz';
    try {
      await expect(setupLinuxSandbox()).rejects.toThrow(/cgroup root/i);
    } finally {
      if (saved === undefined) delete process.env.OCTOPUS_TEST_CGROUP_PARENT;
      else process.env.OCTOPUS_TEST_CGROUP_PARENT = saved;
    }
  }, RUN_TIMEOUT);

  it('runs inside the session netns (route only to the proxy veth)', async (ctx) => {
    if (!needLinux(ctx)) return;
    const running = await startBlockingProbe();
    try {
      // The skill's only non-loopback interface is the os* veth peer with a
      // /32 route to the proxy link-local address — there is no default
      // route off-box.
      const routes = await execInNetns(running.sandbox.netnsName, ['ip', 'route', 'show']);
      expect(routes.code).toBe(0);
      expect(routes.stdout).toContain(running.sandbox.proxyIp);
      expect(routes.stdout).not.toMatch(/^default /m);
      const links = await execInNetns(running.sandbox.netnsName, ['ip', '-o', 'link', 'show']);
      expect(links.stdout).toMatch(/os[0-9a-f]+/);
    } finally {
      await running.cleanup();
    }
  }, RUN_TIMEOUT);
});
