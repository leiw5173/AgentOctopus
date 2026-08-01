/**
 * Plan 6 Task 6 — privileged Linux lane topology tests.
 *
 * Exercises the REAL network topology the OS backend builds:
 *
 *   - the skill process runs INSIDE the session netns whose only non-loopback
 *     route is the /32 peer route to the proxy link-local address (no default
 *     route off-box),
 *   - the session CA bundle is mounted READ-ONLY at the runtime contract path
 *     /etc/skill-ca/ca.pem (proven from INSIDE the sandbox via nsenter against
 *     the real skill PID read from cgroup.procs, M8),
 *   - HTTPS to a granted upstream traverses the externally-launched proxy,
 *   - the nft table inside the netns declares a forward-hook default-drop
 *     chain (structural, parsed from `nft -j list table`), and NO NAT chain,
 *   - the launcher starts EXACTLY ONE proxy (ss -ltnH shows one listener; a
 *     second bind of the same addr:port fails EADDRINUSE, I4 layer b),
 *   - teardown removes every kernel object (netns, host veth, nft table,
 *     skill cgroup) and closes the proxy listener — teardown safety (I2).
 *
 * Gating (M6): `OCTOPUS_REQUIRE_PRIVILEGED_LINUX=1` makes unavailable
 * capabilities FATAL. Otherwise cases skip when the capability is absent
 * (macOS dev hosts) — skipping here is NOT privileged coverage.
 *
 * Leaf-clean: Node stdlib + this package's own src + the Task 1 harness.
 */

import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { createServer } from 'node:net';
import { describe, it, expect, beforeAll } from 'vitest';
import {
  linuxLaneAvailability,
  needPrivilegedLinux,
  setupLinuxSandbox,
  execInNetns,
  ssListenCount,
  parseProbeJson,
  LANE_NODE,
  type LinuxSandbox,
} from './linux-lane-setup.js';

const execFileAsync = promisify(execFile);

const RUN_TIMEOUT = 180_000;

let laneAvailable = false;
beforeAll(async () => {
  laneAvailable = (await linuxLaneAvailability()).available;
});

function needLinux(ctx: unknown): boolean {
  return needPrivilegedLinux(ctx, laneAvailable);
}

// ---------------------------------------------------------------------------
// Helpers (argv-only, host-side).
// ---------------------------------------------------------------------------

interface ExecOut { stdout: string; stderr: string; code: number }

async function runArgv(argv: string[], timeoutMs = 15_000): Promise<ExecOut> {
  const [cmd, ...args] = argv;
  if (!cmd) return { stdout: '', stderr: 'empty argv', code: -1 };
  try {
    const { stdout, stderr } = await execFileAsync(cmd, args, { timeout: timeoutMs });
    return { stdout: String(stdout), stderr: String(stderr), code: 0 };
  } catch (err) {
    const e = err as { stdout?: string; stderr?: string; code?: number | string; message?: string };
    return {
      stdout: String(e.stdout ?? ''),
      stderr: String(e.stderr ?? e.message ?? ''),
      code: typeof e.code === 'number' ? e.code : -1,
    };
  }
}

/** Read the first PID from a skill cgroup's cgroup.procs (the attached helper/skill). */
async function skillPidFromCgroup(cgroupPath: string): Promise<number> {
  const res = await runArgv(['cat', `${cgroupPath}/cgroup.procs`]);
  const pid = Number(res.stdout.split('\n').map((s) => s.trim()).filter(Boolean)[0]);
  if (!Number.isInteger(pid) || pid <= 0) {
    throw new Error(`no skill pid in ${cgroupPath}/cgroup.procs (got '${res.stdout.trim()}')`);
  }
  return pid;
}

/**
 * Start a running sandbox with the blocking probe so the topology exists
 * while assertions run. Returns the sandbox + the running process handle.
 */
async function startTopologySandbox(opts: Parameters<typeof setupLinuxSandbox>[0] = {}): Promise<{
  sandbox: LinuxSandbox;
  proc: Awaited<ReturnType<LinuxSandbox['backend']['spawn']>>;
  skillCgroupPath: string;
  cleanup(): Promise<void>;
}> {
  const sandbox = await setupLinuxSandbox({ timeoutMs: 120_000, ...opts });
  const proc = await sandbox.backend.spawn({
    command: [LANE_NODE, '/skill/probe.js', 'block'],
    timeoutMs: 120_000,
  });
  const skillCgroupPath = sandbox.skillCgroupPath;
  if (!skillCgroupPath) {
    await proc.close().catch(() => {});
    await sandbox.cleanup();
    throw new Error('skillCgroupPath is undefined after prepare — the concrete getter contract broke');
  }
  return {
    sandbox,
    proc,
    skillCgroupPath,
    cleanup: async () => {
      await proc.close().catch(() => {});
      await sandbox.cleanup();
    },
  };
}

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

describe('Linux lane — netns topology', () => {
  it('gives the skill only a /32 peer route to the proxy (no default route off-box)', async (ctx) => {
    if (!needLinux(ctx)) return;
    const t = await startTopologySandbox();
    try {
      const routes = await execInNetns(t.sandbox.netnsName, ['ip', 'route', 'show']);
      expect(routes.code).toBe(0);
      // The only non-loopback route is the /32 link-local peer route to the
      // proxy address; there is no default route.
      expect(routes.stdout).toContain(t.sandbox.proxyIp);
      expect(routes.stdout).not.toMatch(/^default /m);
      // The proxy is reachable at its link-local address:port from inside.
      const listeners = await ssListenCount(t.sandbox.netnsName, t.sandbox.proxyIp, t.sandbox.proxyPort);
      expect(listeners).toBe(1);
    } finally {
      await t.cleanup();
    }
  }, RUN_TIMEOUT);

  it('mounts the session CA read-only at the runtime contract path (nsenter, M8)', async (ctx) => {
    if (!needLinux(ctx)) return;
    const t = await startTopologySandbox();
    try {
      const pid = await skillPidFromCgroup(t.skillCgroupPath);
      // M8: verify from INSIDE the skill's mount namespace (via nsenter
      // against the real PID from cgroup.procs) that the CA bundle is a
      // read-only mount at /etc/skill-ca/ca.pem. /proc/<pid>/mountinfo inside
      // the process's own mount ns records the mount flags.
      const mounts = await runArgv(['nsenter', '-t', String(pid), '-m', '-p', '--', 'cat', '/proc/self/mountinfo']);
      expect(mounts.code).toBe(0);
      const caLine = mounts.stdout.split('\n').find((l) => l.includes('/etc/skill-ca/ca.pem'));
      expect(caLine).toBeDefined();
      // mountinfo field 6 (before the '-') is the mount flags; ro must be set.
      const flags = caLine!.split(' ')[5] ?? '';
      expect(flags.split(',')).toContain('ro');

      // Behavioral proof from inside the sandbox: the probe reads the CA and
      // attempts a write; the write must be denied (ok=true only when the
      // write FAILED).
      const result = await t.sandbox.backend.run({
        command: [LANE_NODE, '/skill/probe.js', 'ca-ro-probe'],
        timeoutMs: 30_000,
      });
      const json = parseProbeJson(result.stdout);
      expect(json.ok).toBe(true);
      expect(json.writeErr).not.toBe('none');
    } finally {
      await t.cleanup();
    }
  }, RUN_TIMEOUT);

  it('reaches a granted upstream through the proxy only (HTTPS via the egress proxy)', async (ctx) => {
    if (!needLinux(ctx)) return;
    // Host-side upstream fixture started BEFORE the nft authorization fixes
    // the table (the initial ruleset's input default-drop would otherwise
    // cut it off). The proxy runs on the HOST, so it can reach a loopback
    // upstream; the skill can only reach it through the proxy.
    let upstream: ReturnType<typeof createServer> | undefined;
    let upstreamUrl = '';
    const t = await startTopologySandbox({
      request: { hosts: ['127.0.0.1'] },
      afterTopology: async () => {
        upstream = createServer((sock) => {
          sock.end('HTTP/1.1 200 OK\r\ncontent-type: text/plain\r\ncontent-length: 2\r\nconnection: close\r\n\r\nok');
        });
        await new Promise<void>((resolveListen, rejectListen) => {
          upstream!.once('error', rejectListen);
          upstream!.listen(0, '127.0.0.1', () => resolveListen());
        });
        const addr = upstream!.address();
        if (addr === null || typeof addr === 'string') throw new Error('upstream fixture has no port');
        upstreamUrl = `http://127.0.0.1:${addr.port}/`;
        return ['127.0.0.1'];
      },
    });
    try {
      const result = await t.sandbox.backend.run({
        command: [LANE_NODE, '/skill/http-probe.js', t.sandbox.proxy.reachableAddr, upstreamUrl],
        timeoutMs: 30_000,
      });
      expect(result.exitCode).toBe(0);
      expect(result.stdout).toContain('ok');
    } finally {
      await t.cleanup();
      if (upstream) await new Promise<void>((r) => upstream!.close(() => r()));
    }
  }, RUN_TIMEOUT);

  it('declares a forward-hook default-drop chain and no NAT chain (structural nft -j)', async (ctx) => {
    if (!needLinux(ctx)) return;
    const t = await startTopologySandbox();
    try {
      expect(t.sandbox.nftTable).toMatch(/^oct_/);
      const dump = await execInNetns(t.sandbox.netnsName, ['nft', '-j', 'list', 'table', 'inet', t.sandbox.nftTable]);
      expect(dump.code).toBe(0);
      const parsed = JSON.parse(dump.stdout) as { nftables?: unknown[] };
      const entries = Array.isArray(parsed.nftables) ? parsed.nftables : [];

      // Structural forward chain: type filter, hook forward, priority 0
      // (normalize prio/priority, tolerate string "0"), policy drop, and NO
      // accept rule inside.
      let forwardChain: { type?: string; hook?: string; policy?: string; prio?: unknown; priority?: unknown; name?: string } | undefined;
      const forwardRules: unknown[] = [];
      const natChains: unknown[] = [];
      for (const entry of entries) {
        const chain = (entry as { chain?: { name?: string; type?: string; hook?: string; policy?: string; prio?: unknown; priority?: unknown } }).chain;
        if (chain) {
          if (chain.name === 'forward') forwardChain = chain;
          if (chain.type === 'nat') natChains.push(chain);
          continue;
        }
        const rule = (entry as { rule?: { chain?: string; expr?: unknown[] } }).rule;
        if (rule && rule.chain === 'forward') forwardRules.push(rule);
      }

      expect(forwardChain).toBeDefined();
      expect(forwardChain!.type).toBe('filter');
      expect(forwardChain!.hook).toBe('forward');
      expect(forwardChain!.policy).toBe('drop');
      const prio = forwardChain!.prio ?? forwardChain!.priority;
      expect(Number(prio)).toBe(0);
      // No accept rule inside the forward chain — forwarded traffic is
      // dropped by policy (IP forwarding itself is never enabled).
      expect(forwardRules).toEqual([]);
      // No NAT chain anywhere in the table.
      expect(natChains).toEqual([]);
    } finally {
      await t.cleanup();
    }
  }, RUN_TIMEOUT);

  it('launches exactly one proxy listener; a second bind fails EADDRINUSE (I4 layer b)', async (ctx) => {
    if (!needLinux(ctx)) return;
    const t = await startTopologySandbox();
    try {
      // ss inside the netns: exactly one listener on proxyIp:proxyPort.
      const listeners = await ssListenCount(t.sandbox.netnsName, t.sandbox.proxyIp, t.sandbox.proxyPort);
      expect(listeners).toBe(1);

      // A second bind of the same addr:port must fail EADDRINUSE — the
      // launcher owns the only proxy for this session.
      await expect(
        new Promise<void>((resolveBind, rejectBind) => {
          const srv = createServer();
          srv.once('error', (err) => rejectBind(err));
          srv.listen(t.sandbox.proxyPort, t.sandbox.proxyIp, () => {
            srv.close(() => rejectBind(new Error('second bind unexpectedly succeeded')));
          });
        }),
      ).rejects.toThrow(/EADDRINUSE/);
    } finally {
      await t.cleanup();
    }
  }, RUN_TIMEOUT);

  it('removes netns, host veth, nft table, and skill cgroup on teardown; closes the proxy listener (I2)', async (ctx) => {
    if (!needLinux(ctx)) return;
    const t = await startTopologySandbox();
    const { netnsName, nftTable, hostVeth, proxyIp, proxyPort } = t.sandbox;
    const cgroupPath = t.skillCgroupPath;

    // Sanity: everything exists while running.
    expect((await runArgv(['ip', 'netns', 'list'])).stdout).toContain(netnsName);

    await t.cleanup();

    // No skill path remains after backend cleanup: the netns, its nft table,
    // the host veth peer, and the skill cgroup are all gone.
    const netnsList = await runArgv(['ip', 'netns', 'list']);
    expect(netnsList.stdout).not.toContain(netnsName);
    const links = await runArgv(['ip', '-o', 'link', 'show']);
    expect(links.stdout).not.toContain(hostVeth);
    // The nft table lived INSIDE the netns; with the netns gone there is no
    // table left (also assert no stray oct_* table in the default ns).
    const defaultNsTables = await runArgv(['nft', 'list', 'tables']);
    expect(defaultNsTables.stdout).not.toContain(nftTable);
    const cgStat = await runArgv(['test', '-d', cgroupPath]);
    expect(cgStat.code).not.toBe(0);

    // No listener remains after the proxy handle closed: a fresh bind of the
    // same addr:port now SUCCEEDS (EADDRINUSE is gone), proving the listener
    // was closed. Bind then immediately release.
    await new Promise<void>((resolveBind, rejectBind) => {
      const srv = createServer();
      srv.once('error', rejectBind);
      srv.listen(proxyPort, proxyIp, () => srv.close(() => resolveBind()));
    });
  }, RUN_TIMEOUT);
});
