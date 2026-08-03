#!/usr/bin/env node
/**
 * security-cleanup-linux.mjs — idempotent teardown of stale session artifacts
 * left behind by a failed/interrupted privileged run:
 *
 *   - named network namespaces   `octn-*` / legacy `octns-*`
 *   - per-session nft tables     `oct_*` / legacy `octsbx_*`
 *   - per-session cgroup v2 dirs `oct-*` (subsumes legacy `oct-sbx-*`)
 *   - leaked egress-proxy processes `node .../egress-proxy-server.mjs`
 *
 * Naming matches Plan 4 (os/netns.ts deriveNames, os/cgroup.ts deriveName).
 *
 * The proxy-process sweep matters most on a PERSISTENT self-hosted runner: a
 * session interrupted mid-run (or a worker killed by the OOM/abort it was
 * diagnosing) never runs the proxy's normal SIGTERM/cgroup.kill teardown, so
 * the netns-mode egress-proxy node process is reparented to PID 1 and leaks.
 * Each leak holds its `octn-*` netns open (so `ip netns delete` alone cannot
 * remove it) and commits tens of MB of V8 VSZ; dozens of leaked proxies push
 * the runner's Committed_AS far past CommitLimit until Node aborts (SIGABRT,
 * exit 134) under memory pressure. Kill the proxies FIRST, then the netns /
 * cgroup teardown below can actually succeed.
 *
 * Idempotent: if nothing matches, or the tools/privileges are unavailable
 * (e.g. macOS dev host, non-root), it reports and exits 0 — there is nothing
 * to clean. Individual removal failures are warnings, not fatal.
 */
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import fs from 'node:fs';
import path from 'node:path';

const execFileAsync = promisify(execFile);

const NETNS_PREFIXES = ['octn-', 'octns-'];
const NFT_PREFIXES = ['oct_', 'octsbx_'];
const CGROUP_PREFIXES = ['oct-', 'oct-proxy-'];
const CGROUP_ROOT = process.env.OCTOPUS_TEST_CGROUP_PARENT || '/sys/fs/cgroup';
// Match the proxy by its bundle entrypoint, not a bare `node` — we must never
// kill an unrelated node process (the runner agent itself is node).
const PROXY_ENTRYPOINT = 'egress-proxy-server.mjs';

function hasPrefix(name, prefixes) {
  return prefixes.some((prefix) => name.startsWith(prefix));
}

let cleaned = 0;
const warnings = [];

async function run(argv) {
  const [cmd, ...args] = argv;
  try {
    const { stdout, stderr } = await execFileAsync(cmd, args, { timeout: 15_000 });
    return { code: 0, stdout: String(stdout), stderr: String(stderr) };
  } catch (err) {
    return {
      code: typeof err.code === 'number' ? err.code : -1,
      stdout: String(err.stdout ?? ''),
      stderr: String(err.stderr ?? err.message ?? ''),
    };
  }
}

function warn(msg) {
  warnings.push(msg);
  console.error(`security-cleanup-linux: WARNING: ${msg}`);
}

/**
 * Kill leaked egress-proxy node processes by scanning /proc for any process
 * whose cmdline references the proxy bundle entrypoint. Returns the number of
 * PIDs signalled. SIGTERM first (lets the proxy close its netns/db cleanly),
 * then a bounded grace, then SIGKILL for any survivor. Excludes this script's
 * own PID and its parent so a self-match can never kill the cleanup run.
 * Reads /proc directly so it does not depend on pgrep/pkill flag differences
 * across distros (and works where pgrep is absent).
 */
function findProxyPids() {
  const pids = [];
  let entries;
  try {
    entries = fs.readdirSync('/proc', { withFileTypes: true });
  } catch {
    return pids; // /proc unreadable — nothing we can do.
  }
  const self = process.pid;
  for (const e of entries) {
    if (!e.isDirectory() || !/^\d+$/.test(e.name)) continue;
    const pid = Number(e.name);
    if (pid === self || pid === process.ppid) continue;
    let cmdline;
    try {
      cmdline = fs.readFileSync(path.join('/proc', e.name, 'cmdline'), 'utf8');
    } catch {
      continue; // raced exit or unreadable — skip.
    }
    if (cmdline.includes(PROXY_ENTRYPOINT)) pids.push(pid);
  }
  return pids;
}

function signalAll(pids, signal) {
  let sent = 0;
  for (const pid of pids) {
    try {
      process.kill(pid, signal);
      sent++;
    } catch { /* already gone or not ours — best-effort */ }
  }
  return sent;
}

function sleepMs(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

async function cleanProxyProcesses() {
  if (process.platform !== 'linux') return;
  const pids = findProxyPids();
  if (pids.length === 0) return;
  console.log(`security-cleanup-linux: killing ${pids.length} leaked egress-proxy process(es): ${pids.join(' ')}`);
  signalAll(pids, 'SIGTERM');
  // Bounded grace for a clean shutdown, then SIGKILL whatever survived.
  await sleepMs(1500);
  const survivors = findProxyPids().filter((pid) => pids.includes(pid));
  if (survivors.length > 0) {
    console.log(`security-cleanup-linux: SIGKILL ${survivors.length} surviving proxy process(es): ${survivors.join(' ')}`);
    signalAll(survivors, 'SIGKILL');
  }
  cleaned += pids.length;
}

async function cleanNetns() {  if (process.platform !== 'linux') return;
  const list = await run(['ip', 'netns', 'list']);
  if (list.code !== 0) return; // iproute2 absent or no privilege — nothing we can do.
  for (const line of list.stdout.split('\n')) {
    const name = line.trim().split(/\s+/)[0];
    if (!name || !hasPrefix(name, NETNS_PREFIXES)) continue;
    const del = await run(['ip', 'netns', 'delete', name]);
    if (del.code === 0) cleaned++;
    else warn(`ip netns delete ${name}: ${del.stderr.trim() || del.stdout.trim()}`);
  }
}

async function cleanNft() {
  if (process.platform !== 'linux') return;
  const list = await run(['nft', '--json', 'list', 'tables']);
  if (list.code !== 0) return; // nft absent or no privilege.
  let tables = [];
  try {
    const parsed = JSON.parse(list.stdout);
    tables = (parsed.nftables ?? [])
      .filter((e) => e.table && e.table.family === 'inet' && typeof e.table.name === 'string')
      .map((e) => e.table.name);
  } catch {
    return; // unparsable — do not guess.
  }
  for (const name of tables) {
    if (!hasPrefix(name, NFT_PREFIXES)) continue;
    const del = await run(['nft', 'delete', 'table', 'inet', name]);
    if (del.code === 0) cleaned++;
    else warn(`nft delete table inet ${name}: ${del.stderr.trim() || del.stdout.trim()}`);
  }
}

async function cleanCgroups() {
  if (process.platform !== 'linux') return;
  let entries;
  try {
    entries = fs.readdirSync(CGROUP_ROOT, { withFileTypes: true });
  } catch {
    return; // cgroup v2 not mounted/readable — nothing to clean.
  }
  for (const e of entries) {
    if (!e.isDirectory() || !hasPrefix(e.name, CGROUP_PREFIXES)) continue;
    const dir = path.join(CGROUP_ROOT, e.name);
    // Reap any stragglers, then remove. Best-effort; cgroup.kill may be absent.
    try {
      const killFile = path.join(dir, 'cgroup.kill');
      if (fs.existsSync(killFile)) fs.writeFileSync(killFile, '1');
    } catch { /* ignore */ }
    try {
      fs.rmdirSync(dir);
      cleaned++;
    } catch (err) {
      warn(`rmdir ${dir}: ${err.message}`);
    }
  }
}

async function main() {
  if (process.platform !== 'linux') {
    console.log(`security-cleanup-linux: OK (nothing to clean — platform=${process.platform}, privileged artifacts are Linux-only)`);
    return;
  }
  // Kill leaked proxies FIRST: a live proxy holds its netns open, so the
  // netns/cgroup teardown below can only fully succeed once the process is
  // gone.
  await cleanProxyProcesses();
  await cleanNetns();
  await cleanNft();
  await cleanCgroups();
  console.log(`security-cleanup-linux: OK (removed ${cleaned} stale artifact(s), ${warnings.length} warning(s))`);
}

main().catch((err) => {
  // Cleanup is best-effort and idempotent; never fail the lane on teardown.
  console.error(`security-cleanup-linux: WARNING: ${err instanceof Error ? err.message : String(err)}`);
  process.exit(0);
});
