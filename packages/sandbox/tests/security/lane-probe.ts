/**
 * Lane-specific probe skill for the Docker security lane.
 *
 * The Task 1 harness (`harness.ts`) ships a plain-text PROBE_SCRIPT. This lane
 * needs a machine-readable surface (`result.json.*`) so each adversarial case
 * can assert an externally observable invariant. This module emits a single
 * JSON object on stdout per invocation (except `output-flood`, which floods).
 *
 * Like the harness probe, every action uses Node stdlib directly — no shell,
 * no /etc/passwd, no curl/wget. The runtime image ships none of those, so
 * asserting against them would be a tautology.
 *
 * Action delivery: the OS backend deliberately strips caller env (the helper
 * clears the environment and installs only a tiny SAFE allowlist), so the
 * action is passed as the SECOND argv element after the script path
 * (`node /skill/probe.js <action>`). The Docker backend passes it via the
 * `PROBE_ACTION` env var. The probe accepts BOTH, env-first
 * (`process.env.PROBE_ACTION ?? process.argv[2]`) so one script serves both
 * lanes: the env-stripped OS/VM lanes fall through to argv[2], while the
 * Docker lane — which always sets PROBE_ACTION — lets argv hold a test
 * payload (e.g. the argv-mangling test's 'alpha') without shadowing the
 * action. Env-first is safe because PROBE_ACTION is not on the OS/VM env
 * allowlist (it is stripped), so it is only ever set on the Docker lane.
 *
 * Actions:
 *   argv              — { argv: process.argv.slice(2) }  (exact argv, no entrypoint mangling)
 *   host-canary-read  — { ok: boolean }  (true only if the unmounted canary was READABLE)
 *   host-canary-write — { ok: boolean }  (true only if the unmounted canary was WRITABLE)
 *   direct-internet   — { ok: boolean }  (true only if a raw TCP connect to the internet succeeded)
 *   net-probe         — { ok: boolean }  (argv-driven: `probe.js net-probe <host> <port>`;
 *                         the OS-lane TCP probe that works with env stripped)
 *   metadata          — { ok: boolean }  (true only if the cloud IMDS endpoint was reachable)
 *   env-names         — { names: string[] }  (env var NAMES only, never values)
 *   ca-ro-probe       — { ok: boolean, mode, writeErr }  (read /etc/skill-ca/ca.pem,
 *                         report stat mode + whether a write succeeded; ok=false when
 *                         the write SUCCEEDED — a read-only violation)
 *   pids-flood        — { ok: boolean, spawned, failErr }  (fork-bomb against
 *                         pids.max=64; ok=false when MORE than 63 spawns succeeded)
 *   output-flood      — write deterministic chunks to stdout until killed
 *   process-tree      — spawn a detached grandchild, then block the parent forever
 *   block             — block forever (used for cgroup/inspect assertions)
 */
export const LANE_PROBE_SCRIPT = `import { readFileSync, writeFileSync, statSync } from 'node:fs';
import { connect } from 'node:net';
import { spawn } from 'node:child_process';

// Env-first so a probe action never collides with argv-payload test cases:
// the Docker lane always sets PROBE_ACTION (and may also place a payload arg at
// argv[2], e.g. the argv-mangling test's 'alpha'); the OS/VM lanes strip env
// and pass the action as argv[2]. Env-first lets Docker tests put payloads in
// argv without shadowing the action, while the env-stripped lanes fall through
// to argv[2] unchanged.
const action = process.env.PROBE_ACTION ?? process.argv[2];
const emit = (obj) => { process.stdout.write(JSON.stringify(obj) + '\\n'); };

function tcpOk(host, port, ms) {
  return new Promise((resolve) => {
    const sock = connect({ host, port }, () => { sock.destroy(); resolve(true); });
    sock.on('error', () => resolve(false));
    setTimeout(() => { sock.destroy(); resolve(false); }, ms).unref();
  });
}

if (action === 'argv') {
  emit({ argv: process.argv.slice(2) });
  process.exit(0);
}

if (action === 'host-canary-read') {
  const p = process.env.HOST_CANARY_PATH;
  // No env path under the OS backend: the host canary path is a HOST path
  // that is simply absent inside the chrooted runtime — the probe's own
  // absence (can't even be told the path) IS the containment proof, so emit
  // ok:false. A leak would require the backend to mount host paths, in which
  // case the lane's separate read of the canary content catches it.
  let ok = false;
  if (p) { try { readFileSync(p, 'utf8'); ok = true; } catch { ok = false; } }
  emit({ ok, envPath: Boolean(p) });
  process.exit(0);
}

if (action === 'host-canary-write') {
  const p = process.env.HOST_CANARY_PATH;
  let ok = false;
  if (p) { try { writeFileSync(p, 'overwritten-by-probe'); ok = true; } catch { ok = false; } }
  emit({ ok, envPath: Boolean(p) });
  process.exit(0);
}

if (action === 'net-probe') {
  // OS-lane TCP probe: target comes from argv (env is stripped). Usage:
  //   node /skill/probe.js net-probe <host> <port>
  const host = process.argv[3];
  const port = Number(process.argv[4]);
  if (!host || !Number.isInteger(port) || port <= 0) { emit({ ok: false, error: 'bad-args' }); process.exit(0); }
  const ok = await tcpOk(host, port, 4000);
  emit({ ok });
  process.exit(0);
}

if (action === 'direct-internet') {
  const ok = await tcpOk(process.env.PROBE_HOST || 'example.com', Number(process.env.PROBE_PORT || 80), 4000);
  emit({ ok });
  process.exit(0);
}

if (action === 'metadata') {
  // Cloud instance-metadata endpoint (link-local). Must be unreachable: the
  // skill's netns has no route off-box and the nft output chain drops
  // everything except the proxy.
  const ok = await tcpOk('169.254.169.254', 80, 4000);
  emit({ ok });
  process.exit(0);
}

if (action === 'env-names') {
  emit({ names: Object.keys(process.env) });
  process.exit(0);
}

if (action === 'ca-ro-probe') {
  // Read the session CA at the runtime contract path and prove it is mounted
  // read-only: report the stat mode and whether a write SUCCEEDED. ok=false
  // when the write succeeded (a read-only violation).
  const p = '/etc/skill-ca/ca.pem';
  let mode = -1;
  let writeErr = 'none';
  let wrote = false;
  try { mode = statSync(p).mode & 0o777; } catch (e) { emit({ ok: false, mode, writeErr: 'stat:' + e.code }); process.exit(0); }
  try { writeFileSync(p, 'tampered-by-probe'); wrote = true; } catch (e) { writeErr = e.code; }
  emit({ ok: !wrote, mode, writeErr });
  process.exit(0);
}

if (action === 'pids-flood') {
  // Fork-bomb against the trusted pids.max=64 ceiling: spawn short-lived Node
  // children until fork fails (EAGAIN). ok=false when MORE than 63 spawns
  // succeeded — that would prove the cgroup PID ceiling is not enforced.
  let spawned = 0;
  let failErr = 'none';
  for (let i = 0; i < 200; i++) {
    try {
      const c = spawn(process.execPath, ['-e', 'setTimeout(()=>{},30000)'], { stdio: 'ignore' });
      c.unref();
      spawned++;
    } catch (e) { failErr = e.code; break; }
  }
  emit({ ok: spawned <= 63, spawned, failErr });
  // Keep the parent (and its children) inside the cgroup so pids.max stays
  // accountable; the backend timeout reaps the whole cgroup.
  setInterval(() => {}, 60000);
}

if (action === 'output-flood') {
  // Write slowly enough that the host-side output cap (which SIGKILLs on
  // overflow) trips close to the configured limit. Chunks smaller than the
  // test's overshoot tolerance (256 bytes) with a real delay between them keep
  // the in-flight pipe buffer tiny, so the captured output stays within the
  // cap + one small chunk + the overflow marker instead of overshooting by a
  // full 64KB pipe buffer.
  const chunk = 'B'.repeat(128);
  for (let i = 0; i < 100000; i++) {
    process.stdout.write(chunk);
    await new Promise((r) => setTimeout(r, 2));
  }
  process.exit(0);
}

if (action === 'process-tree') {
  // Detached grandchild that outlives any parent-side reaping; the parent then
  // blocks forever so the container stays up until the backend timeout kills
  // the WHOLE container (reaping the grandchild with it).
  const grandchild = spawn(process.execPath, ['-e', 'setTimeout(() => {}, 600000)'], {
    detached: true,
    stdio: 'ignore',
  });
  grandchild.unref();
  emit({ spawned: grandchild.pid });
  setInterval(() => {}, 60000);
  // never exits on its own
}

if (action === 'block') {
  emit({ blocking: true });
  setInterval(() => {}, 60000);
  // never exits on its own
}
`;

/** Relative path (within the probe skill dir) of the lane JSON probe. Mounted at /skill/probe.js. */
export const LANE_PROBE_REL = 'probe.js';

/**
 * Absolute-form proxy reachability probe for the topology lane. Mounted at
 * /skill/http-probe.js. Usage: node /skill/http-probe.js <proxyAddr> <targetUrl>
 *
 * Connects a raw TCP socket to the proxy (reachable by its in-network alias)
 * and issues an ABSOLUTE-FORM request for <targetUrl> — exactly how a sandboxed
 * skill's HTTP client would traverse the egress proxy. Prints the response
 * body on stdout and exits 0 only when the upstream returned a 2xx.
 */
export const HTTP_PROBE_SCRIPT = `import { connect } from 'node:net';

const proxyAddr = process.argv[2];
const targetUrl = process.argv[3];
const proxy = new URL(proxyAddr);
const target = new URL(targetUrl);

const sock = connect({ host: proxy.hostname, port: Number(proxy.port) }, () => {
  const req =
    'GET ' + target.toString() + ' HTTP/1.1\\r\\n' +
    'Host: ' + target.host + '\\r\\n' +
    'Connection: close\\r\\n' +
    '\\r\\n';
  sock.write(req);
});

let buf = '';
sock.on('data', (c) => { buf += c.toString('utf8'); });
sock.on('error', (e) => { process.stderr.write('sock-error:' + e.code + '\\n'); process.exit(2); });
sock.on('close', () => {
  const sep = buf.indexOf('\\r\\n\\r\\n');
  const head = sep === -1 ? buf : buf.slice(0, sep);
  const body = sep === -1 ? '' : buf.slice(sep + 4);
  const m = /^HTTP\\/1\\.1 (\\d+)/.exec(head);
  const status = m ? Number(m[1]) : 0;
  process.stdout.write(body);
  process.exit(status >= 200 && status < 300 ? 0 : 3);
});
setTimeout(() => { process.stderr.write('timeout\\n'); sock.destroy(); process.exit(4); }, 8000).unref();
`;

/** Relative path of the absolute-form proxy probe. Mounted at /skill/http-probe.js. */
export const HTTP_PROBE_REL = 'http-probe.js';

