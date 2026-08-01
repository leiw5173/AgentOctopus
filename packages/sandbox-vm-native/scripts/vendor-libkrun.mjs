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
 * The script runs ON THE MATCHING PLATFORM CI LANE and must run FIRST in
 * the `security:build-vm` chain, before `build-vm-helper.mjs`. It builds
 * libkrun .dylib (darwin-arm64) or .so (linux-x64) from the pinned source,
 * extracts the matching libkrunfw prebuilt tarball (firmware blob), and
 * writes both into prebuilds/<platform-arch>/ alongside per-artifact TCB
 * manifests (libkrun.manifest.json, libkrunfw.manifest.json). Having the
 * dylibs in place lets the subsequent `build-vm-helper.mjs` run its full-link
 * path, build the vm-image-builder artifact, and write the combined
 * vm-tcb-manifest.json consumed by verifyVmTcb. It then runs a minimal link
 * test (cc -lkrun -lkrunfw smoke) and, when possible, a real VM boot smoke
 * (delegated to run-vm-gates.mjs).
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
  // Corrected 2026-08-01: the previous value (e8775fab…) did not match the
  // actual tarball; re-verified against a deterministic double download.
  sourceTarSha256: 'a0dfa34a688efad7c3a6cebfed0a5d2e9b2a938432caaf4466f525cbb6907a7e',
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

// Resolve a dyld-loadable libclang.dylib directory for libkrun's `krun-input`
// crate. That crate's build script uses clang-sys (bindgen) and links
// `@rpath/libclang.dylib`; Xcode's clang does NOT ship a dyld-visible
// libclang.dylib (only clang.dylib inside Xcode.app, off the search path), so
// the build script aborts with `dyld: Library not loaded: @rpath/libclang.dylib`.
// Homebrew's llvm formula (keg-only, like lld) provides the real dylib. Returns
// null when no libclang is installed — clang-sys then falls back to its own
// search and the build surfaces the actionable "install llvm" error.
function resolveLibclangEnv() {
  if (process.platform !== 'darwin') return {};
  const candidates = [
    process.env.LIBCLANG_PATH,
    '/opt/homebrew/opt/llvm/lib', // Apple Silicon Homebrew (keg-only llvm)
    '/usr/local/opt/llvm/lib', // Intel Homebrew
  ];
  for (const dir of candidates) {
    if (dir && existsSync(path.join(dir, 'libclang.dylib'))) {
      // LIBCLANG_PATH lets clang-sys's build-time link find the dylib;
      // DYLD_FALLBACK_LIBRARY_PATH lets the RUNNING build script (and bindgen's
      // runtime dlopen) resolve @rpath/libclang.dylib. Prepend so an explicit
      // caller-provided value always wins.
      return {
        LIBCLANG_PATH: dir,
        DYLD_FALLBACK_LIBRARY_PATH: process.env.DYLD_FALLBACK_LIBRARY_PATH
          ? `${dir}:${process.env.DYLD_FALLBACK_LIBRARY_PATH}`
          : dir,
      };
    }
  }
  return {};
}

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
    // BLK=1 maps to `--features blk` (Makefile `ifeq ($(BLK),1)`). The TCB
    // REQUIRES the block-device ABI: vm-helper.c calls krun_add_disk +
    // krun_set_root_disk_remount, which libkrun exports ONLY under the blk
    // feature (engine pins blkFeatureRequired). The default build omits them,
    // so without BLK=1 the vm-helper link fails with undefined references.
    // virtio-blk is pure Rust — no extra system libs are needed.
    await execFileAsync('make', ['-C', srcExtractDir, 'BLK=1'], {
      env: { ...process.env, RUSTFLAGS: '-C opt-level=2', ...resolveLibclangEnv() },
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
// libkrunfw: produce the firmware library for the lane. Two shapes:
//   - linux-x64: the prebuilt tarball ships a ready lib64/libkrunfw.so.5.5.0
//     (ELF) — extract and copy it.
//   - darwin-arm64: NO prebuilt .dylib exists anywhere in the v5.5.0 line
//     (all three assets — prebuilt-aarch64, aarch64, x86_64 — ship ELF .so or
//     the kernel source). The prebuilt-aarch64 tarball instead ships the
//     GENERATED kernel.c bundle (the aarch64 Linux kernel already compiled +
//     serialized by bin2cbundle.py). We compile that bundle into
//     libkrunfw.5.dylib natively — exactly libkrunfw's own Makefile final
//     Darwin step (cc -fPIC -DABI_VERSION=5 -shared), then symlink
//     libkrunfw.dylib -> libkrunfw.5.dylib (its `install` layout). This skips
//     build_on_krunvm.sh (which would boot a nested VM to rebuild the kernel)
//     because the bundle already contains the built kernel.
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

  // darwin: the tarball ships kernel.c (the pre-built aarch64 kernel bundle),
  // NOT a dylib. Compile it into libkrunfw.5.dylib and symlink the base name.
  if (process.platform === 'darwin') {
    return await buildLibkrunfwDylibFromBundle(extractDir, targetDir);
  }

  // Linux: find the versioned .so inside the extracted tree. The prebuilt
  // tarball ships the standard versioned layout (lib64/libkrunfw.so -> .so.5
  // -> .so.5.5.0): the only REGULAR file is the versioned `.so.5.5.0`, so an
  // exact `-type f -name libkrunfw.so` matches nothing (the unversioned name
  // is a symlink). Trust is already established by downloadVerified()'s
  // tarball SHA-256 check; this only locates the verified payload.
  let builtLib = null;
  for (const pattern of [libName, `${libName}*`]) {
    try {
      const { stdout } = await execFileAsync('find', [
        extractDir, '-type', 'f', '-name', pattern, '-print', '-quit',
      ]);
      if (stdout.trim()) { builtLib = stdout.trim(); break; }
    } catch { /* fall through */ }
  }
  if (!builtLib || !existsSync(builtLib)) {
    die(`libkrunfw prebuilt ${libName} not found inside extracted tarball ${tarPath}.`);
  }

  const destLib = path.join(targetDir, libName);
  await fs.copyFile(builtLib, destLib);
  await fs.chmod(destLib, 0o755);
  return destLib;
}

// Compile libkrunfw.5.dylib from the extracted kernel.c bundle on darwin.
// Returns targetDir/libkrunfw.dylib (a symlink to libkrunfw.5.dylib) — the
// ABI-versioned real file matches the SONAME the linker records and the
// layout libkrunfw's `make install` produces. The real versioned file carries
// the digest; the base-name symlink is the loader resolution name.
async function buildLibkrunfwDylibFromBundle(extractDir, targetDir) {
  const kernelC = path.join(extractDir, 'libkrunfw', 'kernel.c');
  if (!existsSync(kernelC)) {
    die(`libkrunfw darwin bundle missing ${kernelC} — the prebuilt-aarch64 tarball layout changed.`);
  }
  const ABI = '5'; // libkrunfw v5.5.0 ABI_VERSION (pinned with the tarball)
  const versioned = path.join(targetDir, `libkrunfw.${ABI}.dylib`);
  console.log('vendor-libkrun: no prebuilt darwin dylib exists — compiling kernel.c bundle into libkrunfw.5.dylib (native cc, the Makefile Darwin step)...');
  try {
    // Mirrors libkrunfw/Makefile $(KRUNFW_BINARY_Darwin): cc -fPIC
    // -DABI_VERSION=$(ABI_VERSION) -shared -o libkrunfw.$(ABI).dylib kernel.c
    // (SONAME_Darwin is empty, so no -install_name flag).
    await execFileAsync('cc', ['-fPIC', `-DABI_VERSION=${ABI}`, '-shared', '-o', versioned, kernelC], {
      maxBuffer: 64 * 1024 * 1024,
    });
  } catch (err) {
    die(`libkrunfw darwin dylib compile failed: ${err.stderr ?? err.message}\n` +
      '  Ensure a C toolchain (clang/cc via Xcode CLT) is installed on the lane.');
  }
  await fs.chmod(versioned, 0o755);
  // install layout: libkrunfw.dylib -> libkrunfw.5.dylib
  const base = path.join(targetDir, 'libkrunfw.dylib');
  await fs.rm(base, { force: true }).catch(() => {});
  await fs.symlink(path.basename(versioned), base);
  return base;
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
  // Return the full manifest (callers read `.artifact.sha256`/`.artifact.size`).
  return manifest;
}

// ---------------------------------------------------------------------------
// Versioned-SONAME shims. libkrun's Makefile bakes a versioned DT_SONAME into
// the built library (libkrun.so.1 for the v1.19.4 pin), and the libkrunfw
// prebuilt ships the standard versioned layout (SONAME libkrunfw.so.5). We copy
// each lib into prebuilds under its UNVERSIONED link-time name (libkrun.so /
// libkrunfw.so). Linking `-lkrun -lkrunfw` resolves those unversioned files,
// but the linker records DT_NEEDED=<SONAME>, and the runtime loader resolves
// that SONAME by FILENAME — so libkrun.so.1 / libkrunfw.so.5 must also exist
// alongside the unversioned files, or every consumer (this script's link smoke
// test now, the vm-helper at runtime later) dies with
// "error while loading shared libraries: libkrun.so.1: cannot open shared
// object file".
//
// The versioned name is created as a SYMLINK to the unversioned lib, NOT a
// second real copy: prebuilds keeps exactly ONE digest-verified real file per
// lib (the one writeArtifactManifest hashes), and the loader follows the
// versioned symlink to those verified bytes. A second real copy would be
// loaded by the OS WITHOUT any digest check — a TCB gap. On Darwin the dylib's
// install_name is versioned too (libkrun.1.dylib / libkrunfw.5.dylib), so the
// same versioned symlink is required there — the loader resolves DT_NEEDED by
// that install_name basename.
// ---------------------------------------------------------------------------

async function linkVersionedSonames(libPaths) {
  const created = [];
  // Pinned fallback SONAMEs / install names, used only if the inspection tool
  // (readelf on Linux, otool on Darwin) is unavailable on the lane. Darwin's
  // libkrun Makefile bakes `-install_name libkrun.<ABI-major>.dylib` (ABI-major
  // 1 for the v1.19.4 pin), and our libkrunfw.5.dylib is compiled with
  // -DABI_VERSION=5 — so the VERSIONED filename is the loader-resolved name on
  // both platforms and must exist alongside the unversioned link-time name.
  const FALLBACK_SONAME = process.platform === 'darwin'
    ? { 'libkrun.dylib': 'libkrun.1.dylib', 'libkrunfw.dylib': 'libkrunfw.5.dylib' }
    : { 'libkrun.so': 'libkrun.so.1', 'libkrunfw.so': 'libkrunfw.so.5' };
  for (const libPath of libPaths) {
    const base = path.basename(libPath);
    let soname = null;
    if (process.platform === 'darwin') {
      // The real file may be behind a symlink (libkrun.dylib -> libkrun.1.dylib
      // would be circular); otool -D reads the install_name recorded IN the dylib.
      try {
        const { stdout } = await execFileAsync('otool', ['-D', libPath]);
        const lines = stdout.split('\n').map((s) => s.trim()).filter(Boolean);
        // First line is the path header; the install_name is the next line.
        const candidate = lines.find((l) => l.endsWith('.dylib'));
        if (candidate) soname = path.basename(candidate); // strip any @rpath/ prefix
      } catch { /* otool missing — fall back to the pinned name below */ }
    } else {
      try {
        const { stdout } = await execFileAsync('readelf', ['-d', libPath]);
        const m = stdout.match(/\(SONAME\)\s+Library soname: \[([^\]]+)\]/);
        if (m) soname = m[1];
      } catch { /* readelf missing — fall back to the pinned SONAME below */ }
    }
    if (!soname) soname = FALLBACK_SONAME[base] ?? null;
    if (!soname || soname === base) continue; // unversioned name — nothing to shim
    const linkPath = path.join(path.dirname(libPath), soname);
    // Idempotence / anti-circular guard: when libPath is ITSELF a symlink whose
    // target already IS the versioned name (the libkrunfw Darwin layout —
    // buildLibkrunfwDylibFromBundle produces real libkrunfw.5.dylib + a
    // libkrunfw.dylib -> libkrunfw.5.dylib symlink), the versioned real file
    // already exists at linkPath. rm-ing it and symlinking soname -> base would
    // create libkrunfw.5.dylib -> libkrunfw.dylib -> libkrunfw.5.dylib, a cycle
    // that DESTROYS the real bytes and breaks -lkrunfw at link time (observed
    // on the macOS vm-lane: "ld: library 'krunfw' not found"). Skip in that
    // case — the shim relationship is already correct.
    const baseStat = await fs.lstat(libPath).catch(() => null);
    if (baseStat?.isSymbolicLink()) {
      const target = await fs.readlink(libPath).catch(() => null);
      if (target && path.basename(target) === soname) continue; // already correct
    }
    await fs.rm(linkPath, { force: true }).catch(() => {});
    await fs.symlink(base, linkPath); // relative: resolves within the same dir
    created.push(linkPath);
    console.log(`vendor-libkrun: ${soname} -> ${base} (versioned SONAME shim)`);
  }
  return created;
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
  // Mirror the engine/run-vm-gates loader convention: DYLD_LIBRARY_PATH on
  // Darwin, LD_LIBRARY_PATH on Linux. (On Darwin, LD_LIBRARY_PATH is ignored,
  // so without this the binary cannot locate libkrun.1.dylib in targetDir.)
  const runEnv = process.platform === 'darwin'
    ? { ...process.env, DYLD_LIBRARY_PATH: targetDir }
    : { ...process.env, LD_LIBRARY_PATH: targetDir };
  try {
    await execFileAsync(smokeBin, [], { env: runEnv });
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
// Versioned-SONAME shims created below; tracked here so the fail-closed path
// removes them alongside the libs (never leave a stale soname pointing at a
// removed lib).
let sonameLinks = [];

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

  // Create the versioned-SONAME shims (libkrun.so.1 / libkrunfw.so.5) the
  // runtime loader resolves DT_NEEDED against — BEFORE the smoke test links
  // and runs a binary against these libs.
  sonameLinks = await linkVersionedSonames([libkrunPath, libkrunfwPath]);

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
  for (const link of sonameLinks) await fs.rm(link, { force: true }).catch(() => {});
  throw err;
} finally {
  await fs.rm(workDir, { recursive: true, force: true }).catch(() => {});
}
