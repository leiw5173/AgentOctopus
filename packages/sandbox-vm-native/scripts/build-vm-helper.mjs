#!/usr/bin/env node
/**
 * build-vm-helper.mjs — producer for the trusted VM TCB artifacts consumed by
 * @agentoctopus/sandbox's verifyVmTcb() (Task 6) and the VM qualification gates.
 *
 * Produces (gitignored, reproducible):
 *   prebuilds/<platform-arch>/sandbox-vm-helper            (mode 0755)
 *   prebuilds/<platform-arch>/sandbox-vm-helper.manifest.json  (per-artifact)
 *   prebuilds/<platform-arch>/vm-image-builder             (mode 0755)
 *   prebuilds/<platform-arch>/vm-image-builder.manifest.json   (per-artifact)
 *   prebuilds/<platform-arch>/vm-tcb-manifest.json             (combined, canonical)
 *
 * where <platform-arch> is e.g. `darwin-arm64` or `linux-x64`.
 *
 * Compile target: src/vm-helper.c against the vendored include/libkrun.h
 * (v1.19.4 ABI pin). The header is committed in this package; the dylibs
 * are produced first by `security:build-vm` running `vendor-libkrun.mjs`
 * before this script. When the dylibs are present under
 * prebuilds/<platform-arch>/, this script links a real binary, ad-hoc
 * codesigns on Darwin with the hypervisor entitlements, builds the
 * vm-image-builder artifact, writes the combined vm-tcb-manifest.json,
 * and runs the verifyVmTcb() self-check.
 *
 * If the dylibs are absent (e.g. a compile-only check on a fresh checkout),
 * this script falls back to a COMPILE-ONLY smoke (cc -c) that proves the
 * source typechecks against the header and writes a `.compile-ok` marker
 * recording the object sha256. It does NOT leave a half-linked fake
 * "helper" binary that pretends to be runnable.
 *
 * Fail-closed everywhere: missing tool/input exits non-zero; no partial
 * artifact is ever left in place.
 */
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { createHash } from 'node:crypto';
import { createReadStream, existsSync } from 'node:fs';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import {
  buildTcbManifest,
  readPerArtifactEntry,
  TCB_MANIFEST_NAME,
  IMAGE_BUILDER_MANIFEST_NAME,
} from './tcb-manifest.mjs';

const execFileAsync = promisify(execFile);

const HERE = path.dirname(fileURLToPath(import.meta.url));
const PKG_ROOT = path.resolve(HERE, '..');
const INCLUDE_DIR = path.join(PKG_ROOT, 'include');
const HELPER_SRC = path.join(PKG_ROOT, 'src', 'vm-helper.c');
const IMAGE_BUILDER_SRC = path.join(PKG_ROOT, 'src', 'vm-image-builder.c');
const HEADER_PATH = path.join(INCLUDE_DIR, 'libkrun.h');

const SHA256_RE = /^[0-9a-f]{64}$/;

function die(msg, exitCode = 1) {
  console.error(`build-vm-helper: ERROR: ${msg}`);
  process.exit(exitCode);
}

function platformArch() {
  const platform = process.platform; // 'darwin' | 'linux'
  const arch = process.arch;         // 'arm64' | 'x64'
  if (platform !== 'darwin' && platform !== 'linux') {
    die(
      `unsupported host platform '${platform}' — vm-helper targets darwin-arm64 and linux-x64 only.`,
    );
  }
  if (arch !== 'arm64' && arch !== 'x64') {
    die(`unsupported host arch '${arch}' — expected arm64 or x64.`);
  }
  return `${platform}-${arch === 'x64' ? 'x64' : arch}`;
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
  die(`helper source not found at ${HELPER_SRC}`);
});
await fs.access(HEADER_PATH).catch(() => {
  die(
    `vendored libkrun.h not found at ${HEADER_PATH}\n` +
    '  Task 11 vendors the v1.19.4 header pin into include/libkrun.h.',
  );
});

try {
  await execFileAsync('cc', ['--version']);
} catch {
  die("required tool 'cc' is not on PATH — install a C toolchain (clang/gcc).");
}

const targetDir = path.join(PKG_ROOT, 'prebuilds', platformArch());
const HELPER_PATH = path.join(targetDir, 'sandbox-vm-helper');
const MANIFEST_PATH = path.join(targetDir, 'sandbox-vm-helper.manifest.json');
const TCB_MANIFEST_PATH = path.join(targetDir, TCB_MANIFEST_NAME);
const IMAGE_BUILDER_PATH = path.join(targetDir, 'vm-image-builder');
const IMAGE_BUILDER_MANIFEST_PATH = path.join(targetDir, IMAGE_BUILDER_MANIFEST_NAME);
const COMPILE_OK_PATH = path.join(targetDir, 'sandbox-vm-helper.compile-ok');
const LIBKRUN_NAME = process.platform === 'darwin' ? 'libkrun.dylib' : 'libkrun.so';
const LIBKRUNFW_NAME = process.platform === 'darwin' ? 'libkrunfw.dylib' : 'libkrunfw.so';
const libkrunPath = path.join(targetDir, LIBKRUN_NAME);
const libkrunfwPath = path.join(targetDir, LIBKRUNFW_NAME);
const haveDylibs = existsSync(libkrunPath) && existsSync(libkrunfwPath);

await fs.mkdir(targetDir, { recursive: true });

// ---------------------------------------------------------------------------
// Darwin codesign entitlements (only used on the full-link path)
// ---------------------------------------------------------------------------

const ENTITLEMENTS_PLIST = `<?xml version="1.0" encoding="UTF-8"?>
<!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN" "http://www.apple.com/DTDs/PropertyList-1.0.dtd">
<plist version="1.0"><dict>
  <key>com.apple.security.hypervisor</key><true/>
  <key>com.apple.vm.networking</key><true/>
</dict></plist>
`;

async function codesignAdHoc(helperPath) {
  if (process.platform !== 'darwin') return;
  // Availability probe: `codesign --version` is NOT a valid codesign flag —
  // Apple's codesign rejects it with exit code 2 ("unrecognized option") even
  // though the binary exists and is on PATH. So a non-zero exit here means the
  // tool is PRESENT (it parsed and rejected the arg); only an ENOENT spawn
  // failure means it is genuinely absent. Treat anything but ENOENT as available
  // and let the real signing call below surface any actual codesign error.
  try {
    await execFileAsync('codesign', ['--version']);
  } catch (err) {
    if (err && err.code === 'ENOENT') {
      die("required tool 'codesign' is not on PATH on Darwin — install Xcode command line tools.");
    }
    // present but rejected the probe flag (e.g. exit 2 on --version) — proceed.
  }
  const tmpEnt = path.join(
    os.tmpdir(),
    `sandbox-vm-helper.entitlements-${process.pid}-${Date.now()}.plist`,
  );
  await fs.writeFile(tmpEnt, ENTITLEMENTS_PLIST);
  try {
    await execFileAsync('codesign', [
      '-s', '-',
      '--entitlements', tmpEnt,
      '--force',
      helperPath,
    ]);
  } catch (err) {
    die(`ad-hoc codesign failed: ${err.stderr ?? err.message}\n` +
      '  Hypervisor.framework requires the com.apple.security.hypervisor entitlement.');
  } finally {
    await fs.rm(tmpEnt, { force: true }).catch(() => {});
  }
}

// ---------------------------------------------------------------------------
// Build the vm-image-builder binary (imageBuilder TCB artifact).
//
// vm-image-builder.c is a self-contained, portable POSIX C program (no
// external deps — it ships its own SHA-256 impl). Compiled with
// -std=c11 -Wall -Wextra -Werror per the source's own build instructions
// (vm-image-builder.c:53-54). Produces:
//   prebuilds/<platform>/vm-image-builder           (mode 0755)
//   prebuilds/<platform>/vm-image-builder.manifest.json  (per-artifact)
//
// The per-artifact manifest is consumed by buildTcbManifest() below to
// assemble the combined vm-tcb-manifest.json. Fail-closed: if the source
// is missing or the compile fails, die() — no partial artifact is left.
// ---------------------------------------------------------------------------

async function buildImageBuilder() {
  if (!existsSync(IMAGE_BUILDER_SRC)) {
    die(`vm-image-builder source not found at ${IMAGE_BUILDER_SRC}`);
  }
  const tmpOut = path.join(targetDir, `.vm-image-builder.tmp-${process.pid}`);
  // vm-image-builder.c:53 — "cc -std=c11 -Wall -Wextra -Werror"
  const args = [
    '-O2', '-std=c11', '-Wall', '-Wextra', '-Werror',
    '-o', tmpOut,
    IMAGE_BUILDER_SRC,
  ];
  try {
    await execFileAsync('cc', args);
  } catch (err) {
    await fs.rm(tmpOut, { force: true }).catch(() => {});
    die(`vm-image-builder compile failed: ${err.stderr ?? err.message}`);
  }
  await fs.chmod(tmpOut, 0o755);
  await fs.rename(tmpOut, IMAGE_BUILDER_PATH);

  // Write the per-artifact manifest (same shape as vendor-libkrun's
  // writeArtifactManifest: {schemaVersion, artifact:{sha256,size,mode}, source}).
  const sha = await sha256File(IMAGE_BUILDER_PATH);
  if (!SHA256_RE.test(sha)) die('internal error: computed imageBuilder digest is not 64 lowercase hex', 3);
  const st = await fs.stat(IMAGE_BUILDER_PATH);
  const manifest = {
    schemaVersion: 1,
    artifact: { sha256: sha, size: st.size, mode: st.mode & 0o777 },
    source: { kind: 'vm-image-builder-c', file: 'src/vm-image-builder.c' },
  };
  await writeAtomic(IMAGE_BUILDER_MANIFEST_PATH, JSON.stringify(manifest, null, 2) + '\n');
  console.log('build-vm-helper: vm-image-builder OK');
  console.log(`  binary:   ${IMAGE_BUILDER_PATH}`);
  console.log(`  sha256:   ${sha}`);
  console.log(`  manifest: ${IMAGE_BUILDER_MANIFEST_PATH}`);
}

// ---------------------------------------------------------------------------
// Path A: full link (dylibs present — post-Task 15)
// ---------------------------------------------------------------------------

async function buildFullLink() {
  const tmpOut = path.join(targetDir, `.sandbox-vm-helper.tmp-${process.pid}`);
  const args = [
    '-O2',
    '-std=gnu17',
    '-D__STDC_WANT_LIB_EXT1__=1',
    '-Wall', '-Werror', '-Wno-comment',
    '-I', INCLUDE_DIR,
    '-o', tmpOut,
    HELPER_SRC,
    `-L${targetDir}`,
    '-lkrun', '-lkrunfw',
  ];
  try {
    await execFileAsync('cc', args);
  } catch (err) {
    await fs.rm(tmpOut, { force: true }).catch(() => {});
    die(
      `link failed: ${err.stderr ?? err.message}\n` +
      `  Ensure ${LIBKRUN_NAME} and ${LIBKRUNFW_NAME} under ${targetDir} are the v1.19.4 build.`,
    );
  }
  await fs.chmod(tmpOut, 0o755);
  await fs.rename(tmpOut, HELPER_PATH);

  await codesignAdHoc(HELPER_PATH);

  const st = await fs.stat(HELPER_PATH);
  const helperSha256 = await sha256File(HELPER_PATH);
  if (!SHA256_RE.test(helperSha256)) die('internal error: computed digest is not 64 lowercase hex', 3);

  const libkrunSha = await sha256File(libkrunPath);
  const libkrunfwSha = await sha256File(libkrunfwPath);

  // Build the vm-image-builder TCB artifact + its per-artifact manifest.
  // This must happen before the combined manifest so the imageBuilder entry
  // is available. Fail-closed if the compile fails (buildImageBuilder dies).
  await buildImageBuilder();

  // Write the per-helper manifest (kept as a build artifact for auditing;
  // same shape as vendor-libkrun's writeArtifactManifest). The canonical
  // contract is the combined vm-tcb-manifest.json below.
  const helperPerArtifactManifest = {
    schemaVersion: 1,
    artifact: { sha256: helperSha256, size: st.size, mode: 0o755 },
    source: { kind: 'sandbox-vm-helper-c', file: 'src/vm-helper.c' },
  };
  await writeAtomic(MANIFEST_PATH, JSON.stringify(helperPerArtifactManifest, null, 2) + '\n');

  // Build the combined vm-tcb-manifest.json with ALL FOUR artifacts
  // (helper, libkrun, libkrunfw, imageBuilder), each {sha256,size,mode}.
  // verifyVmTcb requires all 4 — fail-closed if the imageBuilder per-artifact
  // manifest is absent or malformed (buildTcbManifest throws). NEVER write a
  // 3-artifact combined manifest that verifyVmTcb would reject.
  const libkrunSt = await fs.stat(libkrunPath);
  const libkrunfwSt = await fs.stat(libkrunfwPath);
  const tcbManifestPath = await buildTcbManifest({
    artifactsDir: targetDir,
    helper: { sha256: helperSha256, size: st.size, mode: 0o755 },
    libkrun: { sha256: libkrunSha, size: libkrunSt.size, mode: libkrunSt.mode & 0o777 },
    libkrunfw: { sha256: libkrunfwSha, size: libkrunfwSt.size, mode: libkrunfwSt.mode & 0o777 },
  });

  // Self-check: import verifyVmTcb from @agentoctopus/sandbox dist if
  // available and verify the combined manifest. A rejection here is FATAL —
  // the TCB is incomplete/tampered and must not be shipped.
  let verifyVmTcb = null;
  try {
    const sandboxDist = path.join(PKG_ROOT, '..', 'sandbox', 'dist', 'vm', 'vm-helper-build.js');
    if (existsSync(sandboxDist)) {
      const mod = await import(sandboxDist);
      verifyVmTcb = mod.verifyVmTcb;
    }
  } catch { /* fall through to explicit message */ }

  if (typeof verifyVmTcb !== 'function') {
    console.error(
      'build-vm-helper: WARNING — verifyVmTcb not importable from @agentoctopus/sandbox dist.\n' +
      '  Skipping TCB self-check. Run `pnpm --filter @agentoctopus/sandbox build` to compile it.\n' +
      '  The combined vm-tcb-manifest.json was written; verifyVmTcb will validate it at launch time.',
    );
  } else {
    try {
      await verifyVmTcb({ artifactsDir: targetDir, manifestPath: tcbManifestPath });
      console.log('build-vm-helper: verifyVmTcb OK (combined manifest verified)');
    } catch (err) {
      // FATAL: the combined manifest was rejected. This is NOT "expected
      // until Task 14" — the imageBuilder artifact IS produced above. A
      // rejection means a real integrity failure. Die; do NOT ship a bad TCB.
      die(
        `verifyVmTcb rejected the combined manifest: ${err.message}\n` +
        '  The TCB is incomplete or tampered. Do NOT ship these artifacts.\n' +
        '  All four artifacts (helper, libkrun, libkrunfw, imageBuilder) must verify.',
      );
    }
  }

  console.log('build-vm-helper: OK (full link)');
  console.log(`  helper:    ${HELPER_PATH}`);
  console.log(`  tcb manifest: ${tcbManifestPath}`);
  console.log(`  sha256:    ${helperSha256}`);
  console.log(`  size:      ${st.size}`);
}

// ---------------------------------------------------------------------------
// Path B: compile-only smoke (dylibs absent — expected until Task 15)
// ---------------------------------------------------------------------------

async function buildCompileOnly() {
  const tmpObj = path.join(
    os.tmpdir(),
    `sandbox-vm-helper-${process.pid}-${Date.now()}.o`,
  );
  try {
    // -std=gnu17 (not c99/c11): the vendored libkrun.h pulls in <string.h>
    // whose macOS SDK declares memset_s/errno_t under C11 Annex K guards
    // that only resolve under gnu std + __STDC_WANT_LIB_EXT1__. gnu17 is
    // also what the real libkrun build uses. -Wno-comment silences the
    // upstream header's prose uses of "/dev/input/*" inside block
    // comments (cosmetic, can't edit the vendored verbatim header).
    await execFileAsync('cc', ['-c', '-std=gnu17', '-D__STDC_WANT_LIB_EXT1__=1',
                                '-O2', '-Wall', '-Werror', '-Wno-comment',
                                '-I', INCLUDE_DIR,
                                HELPER_SRC, '-o', tmpObj]);
  } catch (err) {
    await fs.rm(tmpObj, { force: true }).catch(() => {});
    die(
      `compile-only smoke failed: ${err.stderr ?? err.message}\n` +
      `  vm-helper.c must typecheck against include/libkrun.h (v1.19.4 pin).`,
    );
  }
  const objSha = await sha256File(tmpObj);
  const objSt = await fs.stat(tmpObj);
  await fs.rm(tmpObj, { force: true }).catch(() => {});

  // Write a small marker recording the object digest. NOT a runnable
  // binary — explicitly named `.compile-ok` so nothing can mistake it
  // for the helper.
  const marker = {
    schemaVersion: 1,
    kind: 'compile-only-smoke',
    sourceSha256: await sha256File(HELPER_SRC),
    headerSha256: await sha256File(HEADER_PATH),
    objectSha256: objSha,
    objectSize: objSt.size,
    note: 'vm-helper.c typechecks against the vendored libkrun.h v1.19.4 pin. ' +
          'Full link awaits vendored libkrun/libkrunfw dylibs (Task 15). ' +
          'No runnable sandbox-vm-helper binary was produced.',
  };
  await writeAtomic(COMPILE_OK_PATH, JSON.stringify(marker, null, 2) + '\n');

  console.log('build-vm-helper: OK (compile-only smoke)');
  console.log(`  source:   ${HELPER_SRC}`);
  console.log(`  header:   ${HEADER_PATH}`);
  console.log(`  object:   sha256=${objSha} size=${objSt.size}`);
  console.log(`  marker:   ${COMPILE_OK_PATH}`);
  console.log(
    '  NOTE: full link against real libkrun dylibs was NOT performed — they are not\n' +
    '  vendored under prebuilds/' + platformArch() + ' yet (Task 15). No runnable\n' +
    '  sandbox-vm-helper binary was produced; this only proves the source typechecks.',
  );
}

// ---------------------------------------------------------------------------
// Dispatch
// ---------------------------------------------------------------------------

if (haveDylibs) {
  await buildFullLink();
} else {
  await buildCompileOnly();
}
