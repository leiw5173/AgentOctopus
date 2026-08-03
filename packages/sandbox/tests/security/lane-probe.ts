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
 *   pid-info          — { ok: boolean, pid }  (the workload's own PID; ok=true
 *                         only when pid>1, i.e. it runs under vm-init as a child
 *                         of the bootstrap rather than as PID 1 itself)
 *   http-fetch        — { ok, status, err }  (fetch http://<host>/ through the
 *                         egress proxy using the session CA; ok=true on 2xx/3xx)
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

if (action === 'pid-info') {
  // Bootstrap integrity: report the workload's own PID. Inside the VM, vm-init
  // is PID 1 and fork()s the workload, so the workload's PID must be > 1 (a
  // child of the bootstrap, never PID 1 itself). ok=true  ⇒ running under
  // vm-init as intended; ok=false ⇒ the workload pre-empted PID 1 (a bootstrap
  // integrity violation).
  emit({ ok: process.pid > 1, pid: process.pid });
  process.exit(0);
}

if (action === 'http-fetch') {
  // Egress-proxy reachability: fetch http://<host>/ THROUGH the sidecar proxy.
  // buildGuestEnv forces HTTP_PROXY at the guest's loopback<->vsock forwarder,
  // so process.env.HTTP_PROXY names the proxy. The guest node is Node 22, whose
  // built-in fetch (undici) does NOT honor HTTP_PROXY by default (env-proxy
  // support arrived in Node 24 with NODE_USE_ENV_PROXY), so a bare fetch would
  // go DIRECT — and the guest has no network path (G2 invariant). Instead,
  // mirror the topology lane's http-probe.js pattern: connect a raw TCP socket
  // to the proxy and issue an ABSOLUTE-FORM request for http://<host>/.
  // Usage: node /skill/probe.js http-fetch <host>   (host = argv[3])
  const host = process.argv[3];
  const proxyAddr = process.env.HTTP_PROXY || process.env.http_proxy;
  if (!host || !proxyAddr) { emit({ ok: false, error: 'missing host or proxy env' }); process.exit(0); }
  const proxy = new URL(proxyAddr);
  const target = new URL('http://' + host + '/');
  let ok = false; let status = 0; let err = 'none';
  await new Promise((resolvePromise) => {
    const sock = connect({ host: proxy.hostname, port: Number(proxy.port) }, () => {
      const req =
        'GET ' + target.toString() + ' HTTP/1.1\\r\\n' +
        'Host: ' + target.host + '\\r\\n' +
        'Connection: close\\r\\n\\r\\n';
      sock.write(req);
    });
    let buf = '';
    let done = false;
    const settle = () => { if (!done) { done = true; ok = status >= 200 && status < 400; resolvePromise(); } };
    sock.setTimeout(8000, () => { err = 'timeout'; sock.destroy(); });
    sock.on('data', (c) => {
      buf += c.toString('utf8');
      if (status === 0 && buf.includes('\\r\\n')) {
        const m = /^HTTP\\/\\d(?:\\.\\d)? (\\d{3})/.exec(buf);
        if (m) status = Number(m[1]);
      }
    });
    sock.on('end', settle);
    sock.on('error', (e) => { err = e.code ?? e.message; settle(); });
    sock.on('close', settle);
  });
  emit({ ok, status, err });
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
  // children and count how many actually START. ok=false when MORE than 63
  // start — that would prove the cgroup PID ceiling is not enforced.
  //
  // CRITICAL measurement detail: spawn() does NOT throw synchronously when the
  // kernel refuses fork() past pids.max. fork-EAGAIN is delivered ASYNCHRONOUSLY
  // as an 'error' event on the ChildProcess (verified empirically under a
  // pids-limit-64 container: spawn() returned 200 times, 182 async 'error'
  // events, zero sync throws). A try/catch therefore counts spawn-ATTEMPTS
  // (always 200) and can never observe the ceiling. We instead count the 'spawn'
  // event (the child truly started) vs the 'error' event (fork refused), then
  // wait one tick for the async events to settle before emitting.
  let started = 0;
  let refused = 0;
  let failErr = 'none';
  for (let i = 0; i < 200; i++) {
    const c = spawn(process.execPath, ['-e', 'setTimeout(()=>{},30000)'], { stdio: 'ignore' });
    c.on('spawn', () => { started++; });
    c.on('error', (e) => { refused++; if (failErr === 'none') failErr = e.code; });
    c.unref();
  }
  // Give the event loop a moment to deliver every 'spawn'/'error' event before
  // reporting; the counts are meaningless until they settle.
  setTimeout(() => {
    emit({ ok: started <= 63, spawned: started, refused, failErr });
  }, 800);
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

/**
 * Built-in-fetch egress probe for the networking behavior lane. Mounted at
 * /skill/fetch-probe.js. Usage: node /skill/fetch-probe.js <targetUrl>
 *
 * Uses Node's BUILT-IN fetch (undici global dispatcher) — the exact client a
 * real skill uses. The runtime image routes it through the egress proxy ONLY
 * because the backend injects NODE_OPTIONS=--require /opt/octopus-boot/bootstrap.cjs
 * (plus HTTPS_PROXY); without the bootstrap, built-in fetch ignores HTTP(S)_PROXY
 * and fails closed with EAI_AGAIN (guest DNS is cut). This probe therefore proves
 * the bootstrap actually routes fetch.
 *
 * Emits one JSON line: { status, body, error } — status is the upstream HTTP
 * status (0 when the request never got a response), body the response text,
 * error the fetch failure code (e.g. EAI_AGAIN) if it threw.
 */
export const FETCH_PROBE_SCRIPT = `const target = process.argv[2];
const out = (o) => { process.stdout.write(JSON.stringify(o) + '\\n'); };
if (!target) { out({ status: 0, body: '', error: 'bad-args' }); process.exit(0); }
try {
  const res = await fetch(target);
  const body = await res.text();
  out({ status: res.status, body, error: null });
} catch (e) {
  const c = e && e.cause;
  const err = (c && (c.code || c.message)) || (e && (e.code || e.message)) || String(e);
  const causeCode = (c && c.code) || null;
  out({ status: 0, body: '', error: String(err), causeCode });
}
`;

/** Relative path of the built-in-fetch egress probe. Mounted at /skill/fetch-probe.js. */
export const FETCH_PROBE_REL = 'fetch-probe.js';

