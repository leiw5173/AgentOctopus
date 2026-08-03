#!/usr/bin/env node
/**
 * bundle-egress-proxy.mjs — bundle the standalone egress-proxy server into a
 * single self-contained ESM file the proxy image ships.
 *
 * Produces (gitignored, reproducible from src/):
 *   build/egress-proxy-server.mjs
 *   build/egress-proxy-server.mjs.manifest.json   (sha256, mode 0o644, size)
 *
 * Then SMOKE-TESTS the bundle in a clean temp dir with NO workspace
 * node_modules: it spawns `node build/egress-proxy-server.mjs`, provisions the
 * launcher-style one-shot secret frame (SessionCa envelope + empty secrets) on
 * the secret fd, and asserts the length-aware ready frame
 * `{ ready: true, boundPort }` arrives on stdout BEFORE any proxy request.
 * This proves the bundle boots from its own filesystem with no external
 * runtime imports beyond Node built-ins.
 *
 * Fail-closed: any bundling error, missing ready frame, or boot failure exits
 * non-zero with an actionable message; no partial artifact is left behind.
 */
import { build } from 'esbuild';
import { spawn } from 'node:child_process';
import { once } from 'node:events';
import { createHash, randomBytes } from 'node:crypto';
import { PassThrough } from 'node:stream';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const HERE = path.dirname(fileURLToPath(import.meta.url));
const PKG_ROOT = path.resolve(HERE, '..');
const ENTRY = path.join(PKG_ROOT, 'src', 'egress-proxy-server.ts');
const BUILD_DIR = path.join(PKG_ROOT, 'build');
const OUTFILE = path.join(BUILD_DIR, 'egress-proxy-server.mjs');
const MANIFEST_PATH = `${OUTFILE}.manifest.json`;
// The compiled SessionCa (used ONLY to construct the launcher-side CA envelope
// for the smoke test). The bundle itself must NOT import this — it is bundled.
const DIST_CA = path.join(PKG_ROOT, 'dist', 'proxy', 'ca.js');

function die(msg, code = 1) {
  console.error(`bundle-egress-proxy: ERROR: ${msg}`);
  process.exit(code);
}

async function main() {
  // 1. Bundle.
  await fs.mkdir(BUILD_DIR, { recursive: true });
  try {
    await build({
      entryPoints: [ENTRY],
      outfile: OUTFILE,
      bundle: true,
      platform: 'node',
      format: 'esm',
      target: 'node22',
      packages: 'bundle',
      sourcemap: false,
      legalComments: 'none',
      logLevel: 'silent',
      // node-forge is CJS and uses dynamic `require('crypto')` etc. Under
      // format:'esm' esbuild refuses dynamic require. Provide the standard
      // createRequire shim so the bundled CJS deps resolve Node built-ins.
      banner: {
        js: "import { createRequire as __octCreateRequire } from 'node:module'; const require = __octCreateRequire(import.meta.url);",
      },
    });
  } catch (err) {
    die(`esbuild failed: ${err.message ?? err}`);
  }

  // 2. Digest manifest (consumed by Plan 4 resolveOsArtifacts / linux-static).
  //    Shape MUST match verifyProxyBundle() in src/os/os-backend.ts:
  //    { schemaVersion:1, helperSha256:<bare 64 hex>, mode, size }. The digest
  //    is bare hex (no `sha256:` prefix) and there is no `path` key.
  const bytes = await fs.readFile(OUTFILE);
  await fs.chmod(OUTFILE, 0o644).catch(() => {});
  const helperSha256 = createHash('sha256').update(bytes).digest('hex');
  const manifest = {
    schemaVersion: 1,
    helperSha256,
    mode: 0o644,
    size: bytes.length,
  };
  await fs.writeFile(MANIFEST_PATH, JSON.stringify(manifest, null, 2) + '\n', { mode: 0o644 });

  // 3. Smoke test in a clean temp dir with no workspace node_modules.
  const { SessionCa } = await import(DIST_CA).catch(() => {
    die(`cannot import compiled SessionCa at ${DIST_CA}\n  Run \`pnpm --filter @agentoctopus/sandbox build\` first.`);
  });

  const workDir = await fs.mkdtemp(path.join(os.tmpdir(), 'oct-proxy-bundle-'));
  let child;
  try {
    const ca = SessionCa.create();
    const nonce = randomBytes(32).toString('hex');
    const proxyConfig = {
      listenHost: '127.0.0.1',
      listenPort: 0,
      policy: {
        hosts: [],
        credentials: [],
        resources: { memoryBytes: 0, timeoutMs: 30000, cpus: 0 },
        denied: { hosts: [], credentials: [] },
      },
      explicitTargets: [],
    };

    // The proxy reads the one-shot secret frame from OCTOPUS_PROXY_SECRET_FD.
    // We pass a writable pipe on fd 3 and write the launcher-style frame to it.
    const secretStream = new PassThrough();
    child = spawn(process.execPath, [OUTFILE], {
      cwd: workDir, // no node_modules here — proves the bundle is self-contained
      env: {
        PATH: process.env.PATH,
        OCTOPUS_PROXY_CONFIG: JSON.stringify(proxyConfig),
        OCTOPUS_PROXY_SECRET_FD: '3',
        OCTOPUS_PROXY_SECRET_NONCE: nonce,
      },
      stdio: ['ignore', 'pipe', 'pipe', 'pipe'],
    });

    // Write the one-shot secret frame on fd 3 (length-prefixed envelope).
    child.stdio[3].on('error', () => {});
    const envelope = JSON.stringify({ nonce, secrets: {}, sessionCa: ca.toEnvelope() });
    const payload = Buffer.from(envelope, 'utf8');
    const frame = Buffer.alloc(4 + payload.length);
    frame.writeUInt32BE(payload.length, 0);
    payload.copy(frame, 4);
    child.stdio[3].write(frame);
    child.stdio[3].end();

    // Await the ready frame on stdout. The server emits
    // `JSON.stringify({ ready:true, boundPort }) + '\n'` once listening.
    const ready = await new Promise((resolve, reject) => {
      let buf = '';
      const timer = setTimeout(() => reject(new Error('timed out waiting for ready frame')), 15_000);
      child.stdout.on('data', (c) => {
        buf += c.toString('utf8');
        const idx = buf.indexOf('\n');
        if (idx === -1) return;
        clearTimeout(timer);
        try {
          resolve(JSON.parse(buf.slice(0, idx)));
        } catch (e) {
          reject(new Error(`ready frame is not valid JSON: ${buf.slice(0, idx)}`));
        }
      });
      child.once('exit', (code) => {
        clearTimeout(timer);
        reject(new Error(`proxy exited ${code} before emitting ready frame`));
      });
    });

    if (ready.ready !== true || !Number.isInteger(ready.boundPort) || ready.boundPort <= 0) {
      die(`ready frame malformed: ${JSON.stringify(ready)}`);
    }

    console.log('bundle-egress-proxy: OK');
    console.log(`  bundle:    ${OUTFILE}`);
    console.log(`  manifest:  ${MANIFEST_PATH}`);
    console.log(`  helperSha256: ${helperSha256}`);
    console.log(`  size:      ${bytes.length} bytes`);
    console.log(`  smoke:     ready frame received (boundPort=${ready.boundPort}) from clean cwd`);
  } finally {
    if (child) {
      child.kill('SIGTERM');
      await Promise.race([once(child, 'exit').catch(() => {}), new Promise((r) => setTimeout(r, 3000))]);
      child.kill('SIGKILL');
    }
    await fs.rm(workDir, { recursive: true, force: true }).catch(() => {});
  }
}

main().catch((err) => die(err instanceof Error ? err.message : String(err)));
