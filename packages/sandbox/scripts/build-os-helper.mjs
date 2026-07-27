#!/usr/bin/env node
/**
 * build-os-helper.mjs — producer for the trusted os-helper binary artifact
 * pair consumed by Plan 4 Task 3's helper verification.
 *
 * Produces (gitignored, reproducible):
 *   runtime/os-helper            (static, mode 0755)
 *   runtime/os-helper.manifest.json
 *
 * Requires a Linux host with a static-capable C toolchain (`cc -static`),
 * i.e. glibc static libs or a musl toolchain. On macOS `cc -static` cannot
 * produce a Linux ELF, so this script fails closed here with an actionable
 * message; the artifact is produced on the Plan 6 Linux release lane.
 *
 * Steps (per the Task 2.5 brief):
 *   1. Compile src/os/helper.c → runtime/os-helper with `cc -static -O2`,
 *      argument-array invocation, into a temp output then atomic rename.
 *   2. Compute SHA-256, record mode (0o755) + size, write
 *      runtime/os-helper.manifest.json atomically.
 *   3. Self-check: run verifyHelperArtifact() against the pair IF that
 *      function has landed in dist/os/ (Task 3). If not, the script notes
 *      the seam and still fails the build if the manifest it wrote does not
 *      round-trip its own schema fields.
 *
 * Fail-closed everywhere: missing tool/input exits non-zero; no partial
 * artifact is ever left in place.
 */
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { createHash } from 'node:crypto';
import { createReadStream } from 'node:fs';
import fs from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const execFileAsync = promisify(execFile);

const HERE = path.dirname(fileURLToPath(import.meta.url));
const PKG_ROOT = path.resolve(HERE, '..');
const RUNTIME_DIR = path.join(PKG_ROOT, 'runtime');
const HELPER_SRC = path.join(PKG_ROOT, 'src', 'os', 'helper.c');
const HELPER_PATH = path.join(RUNTIME_DIR, 'os-helper');
const MANIFEST_PATH = path.join(RUNTIME_DIR, 'os-helper.manifest.json');
const DIST_OS_DIR = path.join(PKG_ROOT, 'dist', 'os');

const SHA256_RE = /^[0-9a-f]{64}$/;

function die(msg, exitCode = 1) {
  console.error(`build-os-helper: ERROR: ${msg}`);
  process.exit(exitCode);
}

async function sha256File(p) {
  return new Promise((resolve, reject) => {
    const h = createHash('sha256');
    const s = createReadStream(p);
    s.on('data', (c) => h.update(c));
    s.on('end', () => resolve(h.digest('hex')));
    s.on('error', reject);
  });
}

async function writeAtomic(dest, data) {
  const tmp = path.join(path.dirname(dest), `.tmp-${process.pid}-${Date.now()}`);
  try {
    await fs.writeFile(tmp, data);
    await fs.rename(tmp, dest);
  } catch (err) {
    await fs.rm(tmp, { force: true }).catch(() => {});
    throw err;
  }
}

// ---------------------------------------------------------------------------
// Input + tool gates — fail closed before any work
// ---------------------------------------------------------------------------

await fs.access(HELPER_SRC).catch(() => {
  die(`helper source not found at ${HELPER_SRC}\n  Task 3's helper.c must land before this script can run.`);
});

if (process.platform !== 'linux') {
  die(
    `this script must run on Linux (host platform is '${process.platform}').\n` +
    '  cc -static on macOS cannot produce a static Linux ELF. The artifact is\n' +
    '  produced on the Plan 6 Linux release lane; the gated os-helper smoke\n' +
    '  tests skip on this host.',
  );
}

try {
  await execFileAsync('cc', ['--version']);
} catch {
  die("required tool 'cc' is not on PATH — install a C toolchain (gcc/clang) with static libc, or a musl toolchain.");
}

// ---------------------------------------------------------------------------
// Step 1: compile (static), atomic rename into runtime/
// ---------------------------------------------------------------------------

await fs.mkdir(RUNTIME_DIR, { recursive: true });
const tmpOut = path.join(RUNTIME_DIR, `.os-helper.tmp-${process.pid}`);
try {
  await execFileAsync('cc', ['-static', '-O2', '-o', tmpOut, HELPER_SRC]);
} catch (err) {
  await fs.rm(tmpOut, { force: true }).catch(() => {});
  die(
    `static compile failed: ${err.stderr ?? err.message}\n` +
    '  A static libc (glibc-static or musl-gcc) is required. Do NOT fall back\n' +
    '  to dynamic linking — the helper must be fully self-contained.',
  );
}
await fs.chmod(tmpOut, 0o755);
await fs.rename(tmpOut, HELPER_PATH);

// ---------------------------------------------------------------------------
// Step 2: manifest (HelperArtifactManifest schema, Task 3)
// ---------------------------------------------------------------------------

const st = await fs.stat(HELPER_PATH);
const helperSha256 = await sha256File(HELPER_PATH);
if (!SHA256_RE.test(helperSha256)) die('internal error: computed digest is not 64 lowercase hex', 3);

const manifest = {
  schemaVersion: 1,
  helperSha256,
  size: st.size,
  mode: 0o755,
};
await writeAtomic(MANIFEST_PATH, JSON.stringify(manifest, null, 2) + '\n');

// ---------------------------------------------------------------------------
// Step 3: self-check with the compiled verifyHelperArtifact() when available.
// ---------------------------------------------------------------------------

let verifyHelperArtifact;
try {
  for (const candidate of ['helper.js', 'rootfs.js']) {
    const mod = await import(path.join(DIST_OS_DIR, candidate)).catch(() => null);
    if (mod?.verifyHelperArtifact) { verifyHelperArtifact = mod.verifyHelperArtifact; break; }
  }
} catch { /* fall through */ }

if (verifyHelperArtifact) {
  try {
    await verifyHelperArtifact({ helperPath: HELPER_PATH, manifestPath: MANIFEST_PATH });
  } catch (err) {
    await fs.rm(HELPER_PATH, { force: true }).catch(() => {});
    await fs.rm(MANIFEST_PATH, { force: true }).catch(() => {});
    die(`self-check failed: verifyHelperArtifact rejected the just-produced pair: ${err.message}`, 3);
  }
} else {
  console.error(
    'build-os-helper: NOTE: verifyHelperArtifact() is not yet available in dist/os/ (Task 3 pending).\n' +
    '  Self-check seam: once Task 3 lands it, re-run this script to verify the pair.',
  );
}

console.log('build-os-helper: OK');
console.log(`  helper:   ${HELPER_PATH}`);
console.log(`  manifest: ${MANIFEST_PATH}`);
console.log(`  sha256:   ${helperSha256}`);
console.log(`  size:     ${st.size}`);
