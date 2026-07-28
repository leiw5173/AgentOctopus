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
 * Actions:
 *   argv              — { argv: process.argv.slice(2) }  (exact argv, no entrypoint mangling)
 *   host-canary-read  — { ok: boolean }  (true only if the unmounted canary was READABLE)
 *   host-canary-write — { ok: boolean }  (true only if the unmounted canary was WRITABLE)
 *   direct-internet   — { ok: boolean }  (true only if a raw TCP connect to the internet succeeded)
 *   metadata          — { ok: boolean }  (true only if the cloud IMDS endpoint was reachable)
 *   env-names         — { names: string[] }  (env var NAMES only, never values)
 *   output-flood      — write deterministic chunks to stdout until killed
 *   process-tree      — spawn a detached grandchild, then block the parent forever
 *   block             — block forever (used for cgroup/inspect assertions)
 */
export const LANE_PROBE_SCRIPT = `import { readFileSync, writeFileSync } from 'node:fs';
import { connect } from 'node:net';
import { spawn } from 'node:child_process';

const action = process.env.PROBE_ACTION;
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
  let ok = false;
  try { readFileSync(p, 'utf8'); ok = true; } catch { ok = false; }
  emit({ ok });
  process.exit(0);
}

if (action === 'host-canary-write') {
  const p = process.env.HOST_CANARY_PATH;
  let ok = false;
  try { writeFileSync(p, 'overwritten-by-probe'); ok = true; } catch { ok = false; }
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
  // runtime is on an --internal network with no route off-box.
  const ok = await tcpOk('169.254.169.254', 80, 4000);
  emit({ ok });
  process.exit(0);
}

if (action === 'env-names') {
  emit({ names: Object.keys(process.env) });
  process.exit(0);
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

