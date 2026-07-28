#!/usr/bin/env node
/**
 * security-cleanup-linux.mjs — idempotent teardown of stale session artifacts
 * left behind by a failed/interrupted privileged run:
 *
 *   - named network namespaces   `octn-*` / legacy `octns-*`
 *   - per-session nft tables     `oct_*` / legacy `octsbx_*`
 *   - per-session cgroup v2 dirs `oct-*`, `oct-sbx-*`, `octsbx-*`
 *
 * Naming matches Plan 4 (os/netns.ts deriveNames, os/cgroup.ts deriveName).
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
const CGROUP_PREFIXES = ['oct-', 'oct-sbx-', 'octsbx-'];
const CGROUP_ROOT = process.env.OCTOPUS_TEST_CGROUP_PARENT || '/sys/fs/cgroup';

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

async function cleanNetns() {
  if (process.platform !== 'linux') return;
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
