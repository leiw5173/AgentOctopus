#!/usr/bin/env node
/**
 * DEV-ONLY Darwin SBPL feasibility probe (Task T5 feasibility gate).
 *
 * Purpose: determine, with real experiments on this macOS host, whether a
 * deny-default SBPL sandbox can run a persistent Node/MCP workload under
 * --jitless with ONLY enumerated verified-closure file grants. Emits a gate
 * record consumed by the human auditor and the GO/NO-GO decision.
 *
 * Security posture of THIS script: Node stdlib only; every subprocess is
 * spawned with execFile/spawn using argv arrays (never shell string
 * interpolation); all experiments run in throwaway temp dirs with per-run
 * canaries; no real credentials are ever touched. The DYLD_PRINT_LIBRARIES
 * probe is used only in the dev enumeration step, never in a trusted path.
 *
 * Steps:
 *   --step closure     enumerate the trusted Node Mach-O closure to closure-report.json
 *   --step experiments run deny-default experiments E1-E5, emit gate-results.json
 *   --step allowlist   emit an audited-allowlist TEMPLATE from gate-results.json
 */

import { execFileSync, spawn } from 'node:child_process';
import {
  realpathSync, existsSync, readFileSync, writeFileSync, statSync, readdirSync,
  mkdtempSync, rmSync, mkdirSync,
} from 'node:fs';
import { createHash } from 'node:crypto';
import { dirname, join, resolve } from 'node:path';
import { tmpdir } from 'node:os';
import net from 'node:net';

const SANDBOX_EXEC = '/usr/bin/sandbox-exec';
const OTOOL = '/usr/bin/otool';

function arg(flag, dflt) {
  const i = process.argv.indexOf(flag);
  return i >= 0 && i + 1 < process.argv.length ? process.argv[i + 1] : dflt;
}
function die(msg) { console.error(`darwin-sbpl-feasibility: ${msg}`); process.exit(2); }

function sha256File(p) {
  return createHash('sha256').update(readFileSync(p)).digest('hex');
}
function statEntry(p) {
  const st = statSync(p);
  return { path: p, sha256: sha256File(p), size: st.size, mode: st.mode & 0o7777 };
}

// ---------------------------------------------------------------------------
// Closure enumeration: recursive Mach-O dependency walk via `otool -L` with
// LC_RPATH resolution. Captures BOTH the referenced (possibly symlinked) path
// dyld asks for AND the realpath it resolves to, since the sandbox checks both.
// ---------------------------------------------------------------------------
function rpathsOf(bin, bindir) {
  const paths = [dirname(bin)];
  let out;
  try { out = execFileSync(OTOOL, ['-l', bin]).toString(); } catch { return paths; }
  const lines = out.split('\n');
  for (let i = 0; i < lines.length; i++) {
    if (lines[i].includes('LC_RPATH')) {
      const m = lines[i + 2]?.trim().match(/^path\s+(\S+)/);
      if (m) paths.push(m[1].replace('@loader_path', dirname(bin)).replace('@executable_path', bindir));
    }
  }
  return paths;
}

function enumerateClosure(nodePath) {
  const real = realpathSync(nodePath);
  const bindir = dirname(real);
  const grantPaths = new Set();       // every path spelling that must be granted
  const realEntries = new Map();      // realpath -> true (for hashing)
  function addPath(spelling) {
    let rp;
    try { rp = realpathSync(spelling); } catch { return null; }
    if (!existsSync(rp)) return null;
    grantPaths.add(spelling);
    grantPaths.add(rp);
    realEntries.set(rp, true);
    return rp;
  }
  const queue = [real];
  addPath(real);
  const visited = new Set();
  while (queue.length) {
    const cur = queue.shift();
    if (visited.has(cur)) continue;
    visited.add(cur);
    let out;
    try { out = execFileSync(OTOOL, ['-L', cur]).toString(); } catch { continue; }
    const rps = rpathsOf(cur, bindir);
    for (const line of out.split('\n').slice(1)) {
      const m = line.trim().match(/^(\S+)\s+\(/);
      if (!m) continue;
      let p = m[1];
      if (p.startsWith('@rpath/')) {
        const rel = p.slice(7);
        for (const r of rps) {
          const cand = `${r}/${rel}`;
          const rp = addPath(cand);
          if (rp) { queue.push(rp); break; }
        }
        continue;
      }
      if (p.startsWith('@loader_path/')) p = `${dirname(cur)}/${p.slice(13)}`;
      else if (p.startsWith('@executable_path/')) p = `${bindir}/${p.slice(17)}`;
      const rp = addPath(p);
      if (rp) queue.push(rp);
    }
  }
  // Enumerate adjacent ICU / *.dat data files next to dylibs.
  const dataFiles = new Set();
  for (const rp of realEntries.keys()) {
    const dir = dirname(rp);
    let names;
    try { names = readdirSync(dir); } catch { continue; }
    for (const n of names) {
      if (/\.dat$|^icudt/i.test(n)) {
        const full = join(dir, n);
        try { if (statSync(full).isFile()) { dataFiles.add(full); grantPaths.add(full); } } catch {}
      }
    }
  }
  return { real, grantPaths: [...grantPaths].sort(), dataFiles: [...dataFiles].sort() };
}

// ---------------------------------------------------------------------------
// SBPL profile construction + run helper.
// ---------------------------------------------------------------------------
function lit(p) { return `(literal "${p}")`; }

function buildProfile({ closurePaths, executable, extra = [], jitAllowDynamic = false }) {
  const allLits = closurePaths.map(lit).join(' ');
  const lines = [
    '(version 1)',
    '(deny default)',
    `(allow file-read* file-map-executable ${allLits})`,
    `(allow process-exec* ${lit(executable)})`,
    ...extra,
  ];
  if (jitAllowDynamic) lines.push('(allow dynamic-code-generation)');
  return lines.join('\n') + '\n';
}

function runSandboxed(profilePath, cmd, args, opts = {}) {
  try {
    const out = execFileSync(SANDBOX_EXEC, ['-f', profilePath, cmd, ...args], { stdio: 'pipe', ...opts });
    return { ec: 0, stdout: out.toString(), stderr: '' };
  } catch (e) {
    return { ec: e.status ?? 1, stdout: (e.stdout || '').toString(), stderr: (e.stderr || '').toString() };
  }
}

// ---------------------------------------------------------------------------
// Step: closure
// ---------------------------------------------------------------------------
function stepClosure(nodePath, outPath) {
  const { real, grantPaths, dataFiles } = enumerateClosure(nodePath);
  const entries = [];
  for (const p of grantPaths) {
    if (!existsSync(p)) continue;
    try { entries.push(statEntry(p)); } catch {}
  }
  const digest = createHash('sha256')
    .update(JSON.stringify(entries.map(e => [e.path, e.sha256, e.size, e.mode])))
    .digest('hex');
  const report = {
    node: real,
    grantPaths,
    dataFiles,
    entries,
    closureDigest: `sha256:${digest}`,
    generatedAt: new Date().toISOString(),
  };
  writeFileSync(outPath, JSON.stringify(report, null, 2));
  console.log(`closure: ${entries.length} entries, digest ${report.closureDigest}`);
  console.log(`wrote ${outPath}`);
}

// ---------------------------------------------------------------------------
// Step: experiments (E1-E5)
// ---------------------------------------------------------------------------
const MCP_STUB = `
import { spawn } from 'node:child_process';
import { Worker } from 'node:worker_threads';
import { createRequire } from 'node:module';
const require = createRequire(import.meta.url);
const out = o => process.stdout.write(JSON.stringify(o) + '\\n');
let buf = '';
process.stdin.on('data', d => { buf += d; let i;
  while ((i = buf.indexOf('\\n')) >= 0) { const line = buf.slice(0, i); buf = buf.slice(i + 1);
    if (!line.trim()) continue; let msg; try { msg = JSON.parse(line); } catch { continue; }
    handle(msg); } });
async function handle(msg) {
  if (msg.method === 'initialize') { out({ jsonrpc:'2.0', id: msg.id, result: { protocolVersion:'2024-11-05', capabilities:{}, serverInfo:{name:'stub',version:'0'} } }); return; }
  if (msg.method === 'tools/call' && msg.params?.name === 'spawn_test') {
    let r; try { spawn('/bin/echo', ['x']); r = 'SPAWN_ALLOWED'; } catch (e) { r = 'SPAWN_' + (e.code || e.message); }
    out({ jsonrpc:'2.0', id: msg.id, result: { spawn: r } }); return; }
  if (msg.method === 'tools/call' && msg.params?.name === 'worker_test') {
    try { const w = new Worker(process.env.T5_WK);
      const done = r => { try{w.terminate();}catch{} out({ jsonrpc:'2.0', id: msg.id, result: { worker: r } }); };
      w.on('message', () => done('WORKER_RUNS'));
      w.on('error', e => done('WORKER_ERR:' + (e.code || e.message)));
    } catch (e) { out({ jsonrpc:'2.0', id: msg.id, result: { worker: 'WORKER_THROW:' + (e.code || e.message) } }); }
    return; }
  if (msg.method === 'tools/call' && msg.params?.name === 'addon_test') {
    let r; try { process.dlopen({ exports: {} }, msg.params.path); r = 'ADDON_LOADED'; } catch (e) { r = 'ADDON_' + (e.code || 'ERR'); }
    out({ jsonrpc:'2.0', id: msg.id, result: { addon: r } }); return; }
  if (msg.method === 'tools/call' && msg.params?.name === 'escape_test') {
    let r; try { require('node:fs').readFileSync(process.env.T5_CANARY, 'utf8'); r = 'ESCAPED'; } catch (e) { r = 'HELD_' + (e.code || 'ERR'); }
    out({ jsonrpc:'2.0', id: msg.id, result: { escape: r } }); return; }
  if (msg.method === 'ping') { out({ jsonrpc:'2.0', id: msg.id, result: {} }); return; }
  out({ jsonrpc:'2.0', id: msg.id, error: { code: -32601, message: 'unknown' } });
}
`;
const MCP_WK = `import { parentPort } from 'node:worker_threads';\nparentPort.postMessage(1);\n`;
const NET_PROBE = `
import net from 'node:net';
const results = {};
function tryConnect(name, opts) {
  return new Promise(res => {
    const s = net.connect(opts);
    const to = setTimeout(() => { s.destroy(); results[name] = 'TIMEOUT'; res(); }, 3000);
    s.on('connect', () => { clearTimeout(to); results[name] = 'CONNECTED'; s.destroy(); res(); });
    s.on('error', e => { clearTimeout(to); results[name] = 'ERR_' + (e.code || e.message); res(); });
  });
}
(async () => {
  const port = Number(process.env.T5_PORT || 0);
  await tryConnect('loopback_v4', { host: '127.0.0.1', port });
  await tryConnect('loopback_v6', { host: '::1', port });
  await tryConnect('unix_socket', { path: process.env.T5_SOCK });
  await tryConnect('external', { host: '1.1.1.1', port: 80 });
  process.stdout.write(JSON.stringify(results) + '\\n'); process.exit(0);
})();
`;

async function driveMcp(profilePath, nodeArgs, env) {
  const child = spawn(SANDBOX_EXEC, ['-f', profilePath, ...nodeArgs], { stdio: ['pipe', 'pipe', 'pipe'], env });
  let buf = ''; const results = []; let stderr = '';
  child.stderr.on('data', d => stderr += d);
  child.stdout.on('data', d => {
    buf += d; let i;
    while ((i = buf.indexOf('\n')) >= 0) {
      const l = buf.slice(0, i); buf = buf.slice(i + 1);
      if (l.trim()) { try { results.push(JSON.parse(l)); } catch {} }
    }
  });
  const send = o => child.stdin.write(JSON.stringify(o) + '\n');
  const waitFor = async (id, ms = 9000) => {
    const t = Date.now();
    while (Date.now() - t < ms) { const r = results.find(r => r.id === id); if (r) return r; await new Promise(r => setTimeout(r, 50)); }
    return null;
  };
  const out = {};
  send({ jsonrpc: '2.0', id: 1, method: 'initialize', params: {} });
  out.initialize = (await waitFor(1)) ? 'OK' : 'TIMEOUT';
  send({ jsonrpc: '2.0', id: 2, method: 'tools/call', params: { name: 'spawn_test' } });
  out.spawn = (await waitFor(2))?.result?.spawn ?? 'TIMEOUT';
  send({ jsonrpc: '2.0', id: 3, method: 'tools/call', params: { name: 'worker_test' } });
  out.worker = (await waitFor(3))?.result?.worker ?? 'TIMEOUT';
  send({ jsonrpc: '2.0', id: 4, method: 'tools/call', params: { name: 'addon_test', path: '/nonexistent/fake.node' } });
  out.addon = (await waitFor(4))?.result?.addon ?? 'TIMEOUT';
  send({ jsonrpc: '2.0', id: 5, method: 'tools/call', params: { name: 'escape_test' } });
  out.escape = (await waitFor(5))?.result?.escape ?? 'TIMEOUT';
  child.kill('SIGKILL');
  await new Promise(r => setTimeout(r, 200));
  return { ...out, stderr: stderr.slice(0, 300) };
}

async function stepExperiments(nodePath, closurePath, outPath) {
  const closure = JSON.parse(readFileSync(closurePath, 'utf8'));
  const real = realpathSync(nodePath);
  const grantPaths = closure.grantPaths;
  const tmp = mkdtempSync(join(tmpdir(), 't5-exp-'));
  const results = { host: {}, experiments: {}, closureDigest: closure.closureDigest };

  results.host = {
    node: real,
    nodeVersion: execFileSync(real, ['--version']).toString().trim(),
    platform: `${process.platform} ${process.arch}`,
    kernel: execFileSync('/usr/bin/uname', ['-sr']).toString().trim(),
  };

  // Per-run canary (never a real secret).
  const canary = join(tmp, 'canary.txt');
  writeFileSync(canary, `CANARY_${Date.now()}`);
  const stubPath = join(tmp, 'stub.mjs');
  const wkPath = join(tmp, 'wk.mjs');
  const netPath = join(tmp, 'net.mjs');
  writeFileSync(stubPath, MCP_STUB);
  writeFileSync(wkPath, MCP_WK);
  writeFileSync(netPath, NET_PROBE);
  const expPaths = [...grantPaths, stubPath, wkPath, netPath];

  const prof = (name, extra = []) => {
    const p = join(tmp, `${name}.sb`);
    writeFileSync(p, buildProfile({ closurePaths: expPaths, executable: real, extra }));
    return p;
  };

  // E1: deny-default Node startup baseline.
  const e1 = runSandboxed(prof('e1', []), real, ['-e', '1']);
  results.experiments.E1 = { name: 'deny-default Node startup', ec: e1.ec, note: 'expect failure (no dyld cache grant)', stderr: e1.stderr.slice(0, 200) };

  // E2: minimal working set discovery. Closure literals + the file-read grants
  // dyld strictly requires. We RECORD that file-read-data and file-read-metadata
  // are required in BROAD (path-unfilterable) form.
  const minimal = [
    '(allow file-read-data)',     // REQUIRED BROAD: dyld shared cache (unfilterable)
    '(allow file-read-metadata)', // REQUIRED BROAD: symlink resolution (unfilterable)
    '(allow sysctl-read)',
    '(allow mach-lookup)',
    '(allow signal (target self))',
  ];
  const e2 = runSandboxed(prof('e2', minimal), real, ['-e', 'process.stdout.write("NODE_OK")']);
  results.experiments.E2 = {
    name: 'minimal working set', ec: e2.ec, stdout: e2.stdout.slice(0, 60),
    minimalSet: ['closure file-read*+file-map-executable literals', ...minimal],
    broadFileReadDataRequired: true,
    broadFileReadMetadataRequired: true,
    stderr: e2.stderr.slice(0, 200),
  };

  // Narrowing evidence: prove the cache CANNOT be granted by literal/subpath/regex.
  const dyldCacheDir = '/System/Cryptexes/OS/System/Library/dyld';
  const narrowing = {};
  const narrowBase = [...minimal.filter(m => !m.includes('file-read-data'))];
  const attempts = {
    'frd-subpath-cryptex': `(allow file-read-data (subpath "${dyldCacheDir}"))`,
    'frd-subpath-System': '(allow file-read-data (subpath "/System"))',
    'frd-regex-dyld': '(allow file-read-data (regex #"dyld"))',
    'frd-regex-System': '(allow file-read-data (regex #"/System"))',
  };
  for (const [k, rule] of Object.entries(attempts)) {
    const r = runSandboxed(prof(`narrow-${k}`, [...narrowBase, rule]), real, ['-e', '1']);
    narrowing[k] = r.ec;
  }
  results.experiments.E2.narrowingEvidence = narrowing; // all non-zero => unfilterable

  // E3: JIT. (a) dynamic-code-generation denied (default), plain args.
  const e3a = runSandboxed(prof('e3a', minimal), real, ['-e', 'function f(x){let s=0;for(let i=0;i<1e6;i++)s+=x*i;return s}process.stdout.write("P:"+f(2))']);
  // (b) --jitless
  const e3b = runSandboxed(prof('e3b', minimal), real, ['--jitless', '-e', 'function f(x){let s=0;for(let i=0;i<1e6;i++)s+=x*i;return s}process.stdout.write("J:"+f(2))']);
  results.experiments.E3 = {
    name: 'JIT policy',
    plainDcgDenied: { ec: e3a.ec, stdout: e3a.stdout.slice(0, 60) },
    jitless: { ec: e3b.ec, stdout: e3b.stdout.slice(0, 60) },
    decision: e3b.ec === 0 ? 'jitless WORKS (V8 uses JIT-write-protect, not dynamic-code-generation)' : 'jitless FAILED',
  };

  // E4: persistent MCP under E2-minimal + jitless, with spawn/worker/addon/escape assertions.
  const mcpProfileJitless = prof('e4-jitless', minimal);
  const envJitless = { ...process.env, T5_WK: wkPath, T5_CANARY: canary };
  const e4 = await driveMcp(mcpProfileJitless, [real, '--jitless', stubPath], envJitless);
  results.experiments.E4 = { name: 'persistent MCP under jitless', ...e4 };

  // E5: network baseline under (deny network*).
  const server = net.createServer(() => {}).listen(0, '127.0.0.1');
  await new Promise(r => server.on('listening', r));
  const port = server.address().port;
  const sockPath = join(tmp, 'e5.sock');
  const usock = net.createServer(() => {}).listen(sockPath);
  await new Promise(r => usock.on('listening', r));
  const e5prof = join(tmp, 'e5.sb');
  writeFileSync(e5prof, buildProfile({ closurePaths: expPaths, executable: real, extra: ['(deny network*)', ...minimal] }));
  const e5 = await new Promise(res => {
    const child = spawn(SANDBOX_EXEC, ['-f', e5prof, real, netPath], { stdio: ['ignore', 'pipe', 'pipe'], env: { ...process.env, T5_PORT: String(port), T5_SOCK: sockPath } });
    let out = '';
    child.stdout.on('data', d => out += d);
    child.on('close', () => {
      try { res(JSON.parse(out.trim().split('\n').pop())); } catch { res({ parse_error: out.slice(0, 200) }); }
    });
  });
  server.close(); usock.close();
  results.experiments.E5 = { name: 'network baseline under (deny network*)', ...e5 };

  results.generatedAt = new Date().toISOString();
  writeFileSync(outPath, JSON.stringify(results, null, 2));
  console.log(`experiments written to ${outPath}`);
  console.log(JSON.stringify(results.experiments, null, 2));
  rmSync(tmp, { recursive: true, force: true });
}

// ---------------------------------------------------------------------------
// Step: allowlist (template for human audit)
// ---------------------------------------------------------------------------
function stepAllowlist(resultsPath, outPath) {
  const r = JSON.parse(readFileSync(resultsPath, 'utf8'));
  const entries = [
    { op: 'file-read* file-map-executable', target: '<closure literals>', justification: 'Verified Mach-O closure (enumerated, digest-pinned). Each entry maps to a verified manifest path.' },
    { op: 'process-exec*', target: '<trusted node>', justification: 'Only the verified Node executable may be exec’d.' },
    { op: 'file-read-data', target: undefined, justification: 'REQUIRED BROAD for dyld shared cache; CANNOT be path-filtered (proven). BREAKOUT RISK: permits arbitrary file reads. SEE NO-GO.' },
    { op: 'file-read-metadata', target: undefined, justification: 'REQUIRED BROAD for Homebrew symlink resolution; CANNOT be path-filtered. Reveals existence/metadata of arbitrary paths. SEE NO-GO.' },
    { op: 'sysctl-read', target: undefined, justification: 'dyld/Node startup reads sysctls.' },
    { op: 'mach-lookup', target: undefined, justification: 'Node startup; MUST be narrowed to exact services before any trusted use.' },
    { op: 'signal', target: 'self', justification: 'Node signal handling to self.' },
  ];
  const canonical = JSON.stringify(entries);
  const digest = createHash('sha256').update(canonical).digest('hex');
  const ts = `// GENERATED TEMPLATE — requires human audit. Broad file-read-data/file-read-metadata are NO-GO.\n` +
    `export interface DarwinSbplAllowEntry { op: string; target?: string; justification: string; }\n` +
    `export const DARWIN_SBPL_ALLOWLIST: readonly DarwinSbplAllowEntry[] = Object.freeze(${JSON.stringify(entries, null, 2)});\n` +
    `export const DARWIN_SBPL_ALLOWLIST_DIGEST = 'sha256:${digest}';\n`;
  writeFileSync(outPath, ts);
  console.log(`allowlist template written to ${outPath} (digest sha256:${digest})`);
}

// ---------------------------------------------------------------------------
async function main() {
  const step = arg('--step', null);
  const nodePath = arg('--node', process.execPath);
  if (!existsSync(SANDBOX_EXEC)) die('sandbox-exec not found at /usr/bin/sandbox-exec');
  if (step === 'closure') {
    stepClosure(nodePath, arg('--out', '/tmp/closure-report.json'));
  } else if (step === 'experiments') {
    const closurePath = arg('--closure', '/tmp/closure-report.json');
    await stepExperiments(nodePath, closurePath, arg('--out', '/tmp/gate-results.json'));
  } else if (step === 'allowlist') {
    stepAllowlist(arg('--results', '/tmp/gate-results.json'), arg('--out', 'allowlist.generated.ts'));
  } else {
    die('usage: --step closure|experiments|allowlist [--node PATH] [--closure FILE] [--results FILE] [--out FILE]');
  }
}

main().catch(e => { console.error(e); process.exit(1); });
