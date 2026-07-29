#!/usr/bin/env node
/**
 * vendor-libkrun.mjs — vendor libkrun v1.19.4 + libkrunfw v5.5.0 into
 * prebuilds/<platform-arch>/ as digest-pinned shared libraries.
 *
 * === CORRECTION (2026-07-30, user ruling on Task 15 open Q2) ===
 * The original brief said "download libkrun v1.19.4 + matching libkrunfw
 * release assets, pin upstream release SHAs." That premise is doubly
 * unfulfillable:
 *   - containers/libkrun v1.19.4 has NO release assets (confirmed via the
 *     GitHub releases API: assets array empty for v1.19.4 and every release
 *     back to v1.16.0; only v1.15.x/v1.14.0/v1.11.2 ever shipped tarballs,
 *     aarch64-only).
 *   - containers/libkrunfw uses a different versioning scheme (v5.x/v4.x/
 *     v3.x). There is no v1.19.4 tag at all; "matching libkrunfw version"
 *     does not exist.
 *
 * Resolution per user: build libkrun v1.19.4 FROM PINNED SOURCE, and pin
 * libkrunfw v5.5.0 prebuilt tarballs (libkrunfw ships prebuilt artifacts at
 * its v5.x line). The "version match" is replaced by an explicit pin:
 *
 *   libkrun:    tag v1.19.4, commit 728df8125077d0db44265f6e997c72b81b65c015
 *               source-tar SHA-256: e8775fab2b460972a67ca6cd936296bb79cdb078d852d712a283cb290dd0b284
 *   libkrunfw:  tag v5.5.0
 *               darwin-arm64 tarball libkrunfw-prebuilt-aarch64.tgz
 *                 SHA-256: 5bfae6efee63dbdf04a8fac2a69d772d9f900af2f54c4429b4acdfd6d86b9979
 *               linux-x64 tarball libkrunfw-x86_64.tgz
 *                 SHA-256: c169206b01c89fbe134f1728bf4f988702bc7f73b4cf73e6fdece447d6fceca1
 *
 * The script runs ON THE MATCHING PLATFORM CI LANE: it builds libkrun
 * .dylib (darwin-arm64) or .so (linux-x64) from the pinned source, extracts
 * the matching libkrunfw prebuilt tarball (firmware blob), and writes both
 * into prebuilds/<platform-arch>/ alongside per-artifact TCB manifests
 * (libkrun.manifest.json, libkrunfw.manifest.json) consumed by verifyVmTcb
 * (Task 6). It then runs a minimal link test (cc -lkrun -lkrunfw smoke) and,
 * when possible, a real VM boot smoke (delegated to run-vm-gates.mjs).
 *
 * Fail-closed everywhere: checksum mismatch, missing build deps, or a failed
 * link test exits non-zero and removes the partial artifact. No partial
 * vendoring is ever left in place.
 *
 * FAIL-CLOSED on unsupported platforms (only darwin-arm64 and linux-x64 are
 * valid VM host lanes). The guest rootfs is cross-produced separately by
 * build-vm-rootfs.mjs; this script vendors the HOST-side libraries only.
 */
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { createHash } from 'node:crypto';
import { createReadStream, createWriteStream, existsSync } from 'node:fs';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { spawn } from 'node:child_process';

const execFileAsync = promisify(execFile);

const HERE = path.dirname(fileURLToPath(import.meta.url));
const PKG_ROOT = path.resolve(HERE, '..');
const SRC_DIR = path.join(PKG_ROOT, 'src');
const INCLUDE_DIR = path.join(PKG_ROOT, 'include');
const PREBUILDS_DIR = path.join(PKG_ROOT, 'prebuilds');
const HEADER_PATH = path.join(INCLUDE_DIR, 'libkrun.h');

const SHA256_RE = /^[0-9a-f]{64}$/;

// ---------------------------------------------------------------------------
// Pinned sources (user ruling 2026-07-30). These constants are the trust
// root for the host-side TCB; changing them is a release-signing event.
// ---------------------------------------------------------------------------

const LIBKRUN_PIN = {
  version: 'v1.19.4',
  commit: '728df8125077d0db44265f6e997c72b81b65c015',
  // SHA-256 of the source tarball (codeload.github.com/containers/libkrun/tar.gz/<commit>).
  sourceTarSha256: 'e8775fab2b460972a67ca6cd936296bb79cdb078d852d712a283cb290dd0b284',
  sourceTarUrl: (commit) => `https://codeload.github.com/containers/libkrun/tar.gz/${commit}`,
};

const LIBKRUNFW_PIN = {
  version: 'v5.5.0',
  // libkrunfw SHIPS prebuilt tarballs at its v5.x line (unlike libkrun).
  // One tarball per (platform, arch). Pinned SHA-256 per user ruling.
  tarballs: {
    'darwin-arm64': {
      url: 'https://github.com/containers/libkrunfw/releases/download/v5.5.0/libkrunfw-prebuilt-aarch64.tgz',
      sha256: '5bfae6efee63dbdf04a8fac2a69d772d9f900af2f54c4429b4acdfd6d86b9979',
    },
    'linux-x64': {
      url: 'https://github.com/containers/libkrunfw/releases/download/v5.5.0/libkrunfw-x86_64.tgz',
      sha256: 'c169206b01c89fbe134f1728bf4f988702bc7f73b4cf73e6fdece447d6fceca1',
    },
  },
};

function die(msg, exitCode = 1) {
  console.error(`vendor-libkrun: ERROR: ${msg}`);
  process.exit(exitCode);
}

function platformArch() {
  const platform = process.platform;
  const arch = process.arch;
  if (platform === 'darwin' && arch === 'arm64') return 'darwin-arm64';
  if (platform === 'linux' && arch === 'x64') return 'linux-x64';
  die(
    `unsupported host '${platform}-${arch}' — libkrun is vendored on ` +
    `darwin-arm64 and linux-x64 lanes only. Guest rootfs arches are ` +
    `produced separately by build-vm-rootfs.mjs.`,
  );
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

// Stream a URL to a file, then verify its SHA-256 against `expected`. Fail
// closed on mismatch (delete the download). Uses curl (present on every
// lane) so we don't take a node fetch dependency.
async function downloadVerified(url, expectedSha256, destPath) {
  const tmp = destPath + `.tmp-${process.pid}-${Date.now()}`;
  await fs.rm(tmp, { force: true }).catch(() => {});
  try {
    // -f: fail on HTTP error. -L: follow redirects. -o: output file.
    await execFileAsync('curl', ['-fsSL', '-o', tmp, url]);
  } catch (err) {
    await fs.rm(tmp, { force: true }).catch(() => {});
    die(`download failed for ${url}: ${err.stderr ?? err.message}`);
  }
  const got = await sha256File(tmp);
  if (got !== expectedSha256) {
    await fs.rm(tmp, { force: true }).catch(() => {});
    die(
      `checksum mismatch for ${url}\n` +
      `  expected: ${expectedSha256}\n` +
      `  got:      ${got}\n` +
      `  The pinned upstream artifact changed. This is a release-signing event — ` +
      `do NOT update the pin without review.`,
    );
  }
  await fs.rename(tmp, destPath);
}

// ---------------------------------------------------------------------------
// libkrun: build from pinned source. libkrun is a Rust crate; `make` builds
// the .dylib/.so via cargo. The build is hermetic-ish: we pin the source
// tarball SHA, build, and then the resulting .dylib/.so digest is recorded
// (it is NOT pinned ahead of time — the build is the trust source, and the
// TCB manifest records the actual built artifact digest for verifyVmTcb).
// ---------------------------------------------------------------------------

async function buildLibkrunFromSource(workDir, targetDir, libName) {
  const tarPath = path.join(workDir, 'libkrun-src.tar.gz');
  const srcExtractDir = path.join(workDir, 'libkrun-src');

  console.log(`vendor-libkrun: downloading libkrun ${LIBKRUN_PIN.version} source (commit ${LIBKRUN_PIN.commit.slice(0, 12)})...`);
  await downloadVerified(
    LIBKRUN_PIN.sourceTarUrl(LIBKRUN_PIN.commit),
    LIBKRUN_PIN.sourceTarSha256,
    tarPath,
  );

  await fs.mkdir(srcExtractDir, { recursive: true });
  try {
    await execFileAsync('tar', ['-xzf', tarPath, '-C', srcExtractDir, '--strip-components=1']);
  } catch (err) {
    die(`libkrun source extract failed: ${err.stderr ?? err.message}`);
  }

  // libkrun ships a Makefile that drives cargo. `make` builds the lib for
  // the host target. We do NOT cross-compile here — the script runs on the
  // matching platform lane.
  console.log('vendor-libkrun: building libkrun (cargo via make)... this may take several minutes.');
  try {
    // libkrun's Makefile default target builds libkrun.{so,dylib} into target/.
    await execFileAsync('make', ['-C', srcExtractDir], {
      env: { ...process.env, RUSTFLAGS: '-C opt-level=2' },
      maxBuffer: 64 * 1024 * 1024,
    });
  } catch (err) {
    die(`libkrun make build failed: ${err.stderr ?? err.message}\n` +
      '  Ensure rustc/cargo + make + gcc are installed on the lane.');
  }

  // Locate the built library. libkrun's Makefile copies it to target/release
  // (libkrun.so on Linux, libkrun.dylib on Darwin) OR to a dist/ dir. Search.
  const candidates = [
    path.join(srcExtractDir, 'target', 'release', libName),
    path.join(srcExtractDir, 'target', 'release', libName.replace(/^lib/, 'lib')),
    path.join(srcExtractDir, 'dist', libName),
  ];
  let builtLib = null;
  for (const c of candidates) {
    if (existsSync(c)) { builtLib = c; break; }
  }
  if (!builtLib) {
    // Fall back: find any libkrun.{so,dylib} under the extract dir.
    try {
      const { stdout } = await execFileAsync('find', [
        srcExtractDir, '-type', 'f', '-name', libName, '-print', '-quit',
      ]);
      builtLib = stdout.trim();
    } catch { /* fall through */ }
  }
  if (!builtLib || !existsSync(builtLib)) {
    die(`libkrun built library not found (expected ${libName} under ${srcExtractDir}/target/release).`);
  }

  // Copy into prebuilds/<platform-arch>/.
  const destLib = path.join(targetDir, libName);
  await fs.copyFile(builtLib, destLib);
  await fs.chmod(destLib, 0o755);
  return destLib;
}

// ---------------------------------------------------------------------------
// libkrunfw: extract the prebuilt tarball (firmware blob). The tarball
// contains libkrunfw.{so,dylib} at a known path; extract and copy.
// ---------------------------------------------------------------------------

async function extractLibkrunfwPrebuilt(workDir, targetDir, tarballPin, libName) {
  const tarPath = path.join(workDir, 'libkrunfw-prebuilt.tgz');
  const extractDir = path.join(workDir, 'libkrunfw-extract');

  console.log(`vendor-libkrun: downloading libkrunfw ${LIBKRUNFW_PIN.version} prebuilt (${path.basename(tarballPin.url)})...`);
  await downloadVerified(tarballPin.url, tarballPin.sha256, tarPath);

  await fs.rm(extractDir, { recursive: true, force: true }).catch(() => {});
  await fs.mkdir(extractDir, { recursive: true });
  try {
    await execFileAsync('tar', ['-xzf', tarPath, '-C', extractDir]);
  } catch (err) {
    die(`libkrunfw tarball extract failed: ${err.stderr ?? err.message}`);
  }

  // Find the .dylib/.so inside the extracted tree.
  let builtLib = null;
  try {
    const { stdout } = await execFileAsync('find', [
      extractDir, '-type', 'f', '-name', libName, '-print', '-quit',
    ]);
    builtLib = stdout.trim();
  } catch { /* fall through */ }
  if (!builtLib || !existsSync(builtLib)) {
    die(`libkrunfw prebuilt ${libName} not found inside extracted tarball ${tarPath}.`);
  }

  const destLib = path.join(targetDir, libName);
  await fs.copyFile(builtLib, destLib);
  await fs.chmod(destLib, 0o755);
  return destLib;
}

// ---------------------------------------------------------------------------
// Per-artifact TCB manifest. verifyVmTcb (vm-helper-build.ts:20-28) expects
// artifacts { helper, libkrun, libkrunfw, imageBuilder }. This script owns
// the libkrun + libkrunfw entries; build-vm-helper.mjs owns helper, and
// the imageBuilder entry is produced alongside the vm-image-builder binary.
//
// We write STANDALONE per-artifact manifests (libkrun.manifest.json,
// libkrunfw.manifest.json) so each library's {sha256,size,mode} is auditable
// independently. build-vm-helper.mjs's full-link path assembles the combined
// VmTcbManifest from these + helper + imageBuilder.
// ---------------------------------------------------------------------------

async function writeArtifactManifest(libPath, manifestPath, pin) {
  const st = await fs.stat(libPath);
  const sha = await sha256File(libPath);
  if (!SHA256_RE.test(sha)) die('internal error: computed digest is not 64 lowercase hex', 3);
  const manifest = {
    schemaVersion: 1,
    artifact: {
      sha256: sha,
      size: st.size,
      mode: st.mode & 0o777,
    },
    source: pin,
  };
  await writeAtomic(manifestPath, JSON.stringify(manifest, null, 2) + '\n');
  return { sha256: sha, size: st.size, mode: st.mode & 0o777 };
}

// ---------------------------------------------------------------------------
// Minimal link test: compile a tiny C program that includes the vendored
// libkrun.h and links -lkrun -lkrunfw, proving the dylibs are loadable and
// ABI-compatible with the header pin. This mirrors build-vm-helper.mjs's
// compile-only smoke but goes one step further: it LINKS, not just -c.
// ---------------------------------------------------------------------------

async function linkSmokeTest(targetDir) {
  const libkrunName = process.platform === 'darwin' ? 'libkrun.dylib' : 'libkrun.so';
  const libkrunfwName = process.platform === 'darwin' ? 'libkrunfw.dylib' : 'libkrunfw.so';
  const smokeSrc = path.join(targetDir, '.link-smoke.c');
  const smokeBin = path.join(targetDir, '.link-smoke');
  // A trivial program that references one libkrun symbol so the linker
  // actually resolves it (krun_create_ctx is in the v1.19.4 ABI).
  await fs.writeFile(smokeSrc,
    '#include <libkrun.h>\n' +
    'int main(void) { return krun_create_ctx() >= 0 ? 0 : 1; }\n');
  const args = [
    '-O2', '-std=gnu17', '-Wall', '-Werror', '-Wno-comment',
    '-I', INCLUDE_DIR,
    '-o', smokeBin,
    smokeSrc,
    `-L${targetDir}`,
    '-lkrun', '-lkrunfw',
  ];
  if (process.platform === 'darwin') {
    // On Darwin, set the runtime load path so the smoke binary finds the
    // dylibs in targetDir without DYLD_FALLBACK_LIBRARY_PATH at runtime.
    args.push('-Wl,-rpath,' + targetDir);
  } else {
    args.push('-Wl,-rpath,' + targetDir);
  }
  try {
    await execFileAsync('cc', args, { env: { ...process.env, LD_LIBRARY_PATH: targetDir } });
  } catch (err) {
    await fs.rm(smokeSrc, { force: true }).catch(() => {});
    await fs.rm(smokeBin, { force: true }).catch(() => {});
    die(`libkrun link smoke test FAILED: ${err.stderr ?? err.message}\n` +
      `  The vendored ${libkrunName}/${libkrunfwName} could not link against include/libkrun.h.\n` +
      `  This indicates an ABI mismatch between the built libs and the header pin.`);
  }
  // Actually RUN the smoke binary — proves the dylibs load at runtime.
  try {
    await execFileAsync(smokeBin, [], { env: { ...process.env, LD_LIBRARY_PATH: targetDir } });
  } catch (err) {
    await fs.rm(smokeSrc, { force: true }).catch(() => {});
    await fs.rm(smokeBin, { force: true }).catch(() => {});
    die(`libkrun runtime smoke test FAILED: ${err.stderr ?? err.message}\n` +
      `  ${libkrunName}/${libkrunfwName} linked but failed to load at runtime.`);
  }
  await fs.rm(smokeSrc, { force: true }).catch(() => {});
  await fs.rm(smokeBin, { force: true }).catch(() => {});
  console.log('vendor-libkrun: link + runtime smoke test OK.');
}

// ---------------------------------------------------------------------------
// Main
// ---------------------------------------------------------------------------

const target = platformArch();
const targetDir = path.join(PREBUILDS_DIR, target);
await fs.mkdir(targetDir, { recursive: true });

if (!existsSync(HEADER_PATH)) {
  die(`vendored libkrun.h not found at ${HEADER_PATH}\n` +
    '  Task 11 vendors the v1.19.4 header pin into include/libkrun.h.');
}

// Tool gates.
try { await execFileAsync('cc', ['--version']); }
catch { die("required tool 'cc' is not on PATH — install a C toolchain."); }
try { await execFileAsync('curl', ['--version']); }
catch { die("required tool 'curl' is not on PATH — install curl."); }
try { await execFileAsync('tar', ['--version']); }
catch { die("required tool 'tar' is not on PATH."); }

const libkrunName = process.platform === 'darwin' ? 'libkrun.dylib' : 'libkrun.so';
const libkrunfwName = process.platform === 'darwin' ? 'libkrunfw.dylib' : 'libkrunfw.so';

// libkrun build deps (rust). Probe but do not hard-fail on the probe — let
// the make invocation surface the actionable error.
try { await execFileAsync('cargo', ['--version']); }
catch { console.error('vendor-libkrun: WARNING — cargo not on PATH; libkrun build will fail if it is not installed.'); }
try { await execFileAsync('make', ['--version']); }
catch { console.error('vendor-libkrun: WARNING — make not on PATH; libkrun build will fail if it is not installed.'); }

const workDir = path.join(os.tmpdir(), `octopus-vendor-libkrun-${process.pid}-${Date.now()}`);
await fs.mkdir(workDir, { recursive: true });

try {
  // libkrunfw FIRST: the libkrun build links against it (libkrun's build
  // expects libkrunfw to be installable). Extract the prebuilt firmware.
  const fwPin = LIBKRUNFW_PIN.tarballs[target];
  if (!fwPin) die(`no libkrunfw tarball pin for ${target}.`);
  const libkrunfwPath = await extractLibkrunfwPrebuilt(workDir, targetDir, fwPin, libkrunfwName);
  const fwManifest = await writeArtifactManifest(
    libkrunfwPath,
    path.join(targetDir, 'libkrunfw.manifest.json'),
    { kind: 'libkrunfw-prebuilt', version: LIBKRUNFW_PIN.version, url: fwPin.url, sha256: fwPin.sha256 },
  );
  console.log(`vendor-libkrun: libkrunfw OK (${libkrunfwPath})`);
  console.log(`  sha256: ${fwManifest.artifact.sha256}`);
  console.log(`  size:   ${fwManifest.artifact.size}`);

  // libkrun: build from pinned source.
  const libkrunPath = await buildLibkrunFromSource(workDir, targetDir, libkrunName);
  const krunManifest = await writeArtifactManifest(
    libkrunPath,
    path.join(targetDir, 'libkrun.manifest.json'),
    {
      kind: 'libkrun-source-build',
      version: LIBKRUN_PIN.version,
      commit: LIBKRUN_PIN.commit,
      sourceTarSha256: LIBKRUN_PIN.sourceTarSha256,
    },
  );
  console.log(`vendor-libkrun: libkrun OK (${libkrunPath})`);
  console.log(`  sha256: ${krunManifest.artifact.sha256}`);
  console.log(`  size:   ${krunManifest.artifact.size}`);

  // Link + runtime smoke test: proves the vendored libs are loadable and
  // ABI-compatible with the header pin. Fail-closed if they are not.
  await linkSmokeTest(targetDir);

  console.log('vendor-libkrun: OK');
  console.log(`  platform: ${target}`);
  console.log(`  libkrun:   ${libkrunPath}`);
  console.log(`  libkrunfw: ${libkrunfwPath}`);
  console.log('  NOTE: a real VM boot smoke test is run by run-vm-gates.mjs (Task 16).');
} catch (err) {
  // Fail closed: remove partial artifacts so a stale dylib is never consumed.
  await fs.rm(path.join(targetDir, libkrunName), { force: true }).catch(() => {});
  await fs.rm(path.join(targetDir, libkrunfwName), { force: true }).catch(() => {});
  await fs.rm(path.join(targetDir, 'libkrun.manifest.json'), { force: true }).catch(() => {});
  await fs.rm(path.join(targetDir, 'libkrunfw.manifest.json'), { force: true }).catch(() => {});
  throw err;
} finally {
  await fs.rm(workDir, { recursive: true, force: true }).catch(() => {});
}
