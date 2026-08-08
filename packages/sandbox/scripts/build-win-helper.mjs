#!/usr/bin/env node
/**
 * build-win-helper.mjs — producer for the trusted Windows sandbox artifacts
 * consumed by @agentoctopus/sandbox's Windows backend and its
 * verifyWindowsRuntimeManifest() (src/windows/runtime-manifest.ts).
 *
 * Produces (gitignored, reproducible) under prebuilds/windows-x64/:
 *   octopus-sandbox-helper.exe            (helper, Tasks 7-8 C source)
 *   octopus-sandbox-helper.exe.manifest.json   (per-artifact)
 *   octopus-sandbox-gate-svc.exe          (companion gate service)
 *   octopus-sandbox-gate-svc.exe.manifest.json (per-artifact)
 *   runtime.manifest.json                 (Node + bootstrap.cjs + vendored
 *                                          undici closure; schemaVersion 1,
 *                                          consumable by the Task 4 verifier)
 *
 * Compile target: src/windows/helper.c and src/windows/gate-svc.c with MSVC
 * cl.exe, located via vswhere (VS Installer) first, then PATH. The runtime
 * closure vendors: node.exe (from the running Node on the Windows host —
 * process.execPath), images/runtime/bootstrap.cjs, and the pinned undici
 * tree under images/runtime/undici/ (produced by scripts/vendor-undici.mjs).
 *
 * If cl.exe is present but the runtime-closure inputs are not all in place,
 * this script falls back to a COMPILE-ONLY smoke (cl /c) that proves the C
 * sources compile and writes a `.compile-ok` marker recording the object
 * sha256. It does NOT leave a half-linked fake ".exe" that pretends to be
 * runnable.
 *
 * This module is import-safe: the build only runs when the file is executed
 * directly (node scripts/build-win-helper.mjs). Tests import the helpers
 * below without triggering any filesystem work.
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
import { writePerArtifactManifest } from './tcb-manifest.mjs';

const execFileAsync = promisify(execFile);

const HERE = path.dirname(fileURLToPath(import.meta.url));
const PKG_ROOT = path.resolve(HERE, '..');
const HELPER_SRC = path.join(PKG_ROOT, 'src', 'windows', 'helper.c');
const GATE_SVC_SRC = path.join(PKG_ROOT, 'src', 'windows', 'gate-svc.c');
const BOOTSTRAP_PATH = path.join(PKG_ROOT, 'images', 'runtime', 'bootstrap.cjs');
const UNDICI_DIR = path.join(PKG_ROOT, 'images', 'runtime', 'undici');
const IMAGES_LOCK_PATH = path.join(PKG_ROOT, 'images', 'images.lock.json');

const SHA256_RE = /^[0-9a-f]{64}$/;

const TARGET_PLATFORM_ARCH = 'windows-x64';

function die(msg, exitCode = 1) {
  console.error(`build-win-helper: ERROR: ${msg}`);
  process.exit(exitCode);
}

/**
 * Hash a file as 64-char lowercase hex sha256. Streamed so multi-hundred-MB
 * node.exe copies do not load into memory.
 *
 * @param {string} p - path to the file
 * @returns {Promise<string>}
 */
export async function sha256File(p) {
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
// Tool discovery — MSVC cl.exe via vswhere first, then PATH
// ---------------------------------------------------------------------------

const VSWHERE_PATH = path.join(
  process.env['ProgramFiles(x86)'] ?? 'C:\\Program Files (x86)',
  'Microsoft Visual Studio',
  'Installer',
  'vswhere.exe',
);

/**
 * Locate the MSVC compiler (cl.exe). Tries vswhere.exe (the canonical VS
 * Installer query tool) first, then falls back to a bare `cl.exe` on PATH.
 * Returns null when neither yields a working compiler — the caller decides
 * whether that is fatal (full build) or a skip (compile-only smoke is also
 * impossible without cl.exe, so it is always fatal today, but keep the
 * distinction so a future clang-cl cross-compile lane can hook in here).
 */
async function findCl() {
  if (process.platform === 'win32' && existsSync(VSWHERE_PATH)) {
    try {
      const { stdout } = await execFileAsync(VSWHERE_PATH, [
        '-latest',
        '-products', '*',
        '-requires', 'Microsoft.VisualStudio.Component.VC.Tools.x86.x64',
        '-property', 'installationPath',
      ]);
      const installPath = String(stdout).trim().split(/\r?\n/)[0];
      if (installPath) {
        // The exact MSVC toolset version dir varies; find the newest
        // cl.exe under the host-x64 target-x64 bin directory.
        const msvcRoot = path.join(installPath, 'VC', 'Tools', 'MSVC');
        const versions = (await fs.readdir(msvcRoot).catch(() => []))
          .filter((v) => /^\d+\./.test(v))
          .sort()
          .reverse();
        for (const v of versions) {
          const candidate = path.join(msvcRoot, v, 'bin', 'Hostx64', 'x64', 'cl.exe');
          if (existsSync(candidate)) return candidate;
        }
      }
    } catch {
      // vswhere failed — fall through to PATH probe.
    }
  }
  try {
    await execFileAsync('cl.exe', []);
    return 'cl.exe';
  } catch (err) {
    // cl with no args prints its banner and exits non-zero (typically 2) —
    // that means it IS present. Only an ENOENT spawn failure means absent.
    if (err && err.code === 'ENOENT') return null;
    return 'cl.exe';
  }
}

// ---------------------------------------------------------------------------
// Input gates — fail closed before any work
// ---------------------------------------------------------------------------

async function requireFile(p, hint) {
  await fs.access(p).catch(() => {
    die(`required input not found at ${p}\n  ${hint}`);
  });
}

// ---------------------------------------------------------------------------
// Compile one C source to a .obj, atomically. Returns the object path.
// ---------------------------------------------------------------------------

async function compileObj(cl, src, objPath) {
  const tmpObj = `${objPath}.tmp-${process.pid}`;
  const args = [
    '/nologo',
    '/c', // compile only, no link
    '/W4',
    '/WX', // warnings as errors — matches -Werror discipline in the vm build
    '/O2',
    '/std:c17',
    `/Fo${tmpObj}`,
    src,
  ];
  try {
    await execFileAsync(cl, args);
  } catch (err) {
    await fs.rm(tmpObj, { force: true }).catch(() => {});
    die(`compile failed for ${src}: ${err.stderr ?? err.stdout ?? err.message}`);
  }
  await fs.rename(tmpObj, objPath);
  return objPath;
}

// ---------------------------------------------------------------------------
// Link one .obj to an .exe, atomically. Returns the exe path.
// ---------------------------------------------------------------------------

async function linkExe(cl, objPath, exePath) {
  const tmpExe = `${exePath}.tmp-${process.pid}`;
  // cl links when given an .obj without /c; /link pass-through carries OUT:.
  const args = ['/nologo', objPath, '/link', `/OUT:${tmpExe}`];
  try {
    await execFileAsync(cl, args);
  } catch (err) {
    await fs.rm(tmpExe, { force: true }).catch(() => {});
    die(`link failed for ${objPath}: ${err.stderr ?? err.stdout ?? err.message}`);
  }
  await fs.rename(tmpExe, exePath);
  return exePath;
}

// ---------------------------------------------------------------------------
// Per-artifact manifest writer — sha256/size/mode of a file on disk.
// mode is 0 on Windows (POSIX mode bits are not meaningful on NTFS); the
// Task 4 runtime-manifest verifier does not enforce mode for the same
// reason. The per-artifact manifest keeps the field for schema parity with
// the vm-native producer so the shared tcb-manifest helpers work unchanged.
// ---------------------------------------------------------------------------

async function manifestEntryFor(p) {
  const sha = await sha256File(p);
  if (!SHA256_RE.test(sha)) die('internal error: computed digest is not 64 lowercase hex', 3);
  const st = await fs.stat(p);
  return { sha256: sha, size: st.size, mode: 0 };
}

// ---------------------------------------------------------------------------
// Runtime closure — node.exe + bootstrap.cjs + vendored undici.
//
// On the Windows host the trusted node.exe is process.execPath (the Node
// running this script — CI pins the toolchain, so the producer's Node IS
// the runtime Node). bootstrap.cjs and undici live under images/runtime/;
// vendor-undici.mjs must have run first (fail-closed check below).
//
// Writes runtime.manifest.json (schemaVersion 1) with absolute paths into
// the prebuilds dir so verifyWindowsRuntimeManifest() can verify them in
// place. entries[] covers node.exe, bootstrap.cjs, and every file under
// undici/ recursively.
// ---------------------------------------------------------------------------

async function writeRuntimeManifest(targetDir, nodeSrcPath) {
  const runtimeDir = path.join(targetDir, 'runtime');
  const nodeDest = path.join(runtimeDir, 'node.exe');
  const bootstrapDest = path.join(runtimeDir, 'bootstrap.cjs');
  const undiciDest = path.join(runtimeDir, 'undici');

  await fs.mkdir(undiciDest, { recursive: true });
  await fs.copyFile(nodeSrcPath, nodeDest);
  await fs.copyFile(BOOTSTRAP_PATH, bootstrapDest);
  await fs.cp(UNDICI_DIR, undiciDest, { recursive: true });

  /** Recursively enumerate every file under root, sorted for determinism. */
  async function walk(root) {
    const out = [];
    const entries = await fs.readdir(root, { withFileTypes: true });
    entries.sort((a, b) => a.name.localeCompare(b.name));
    for (const e of entries) {
      const p = path.join(root, e.name);
      if (e.isDirectory()) out.push(...(await walk(p)));
      else if (e.isFile()) out.push(p);
    }
    return out;
  }

  const nodeSha = await sha256File(nodeDest);
  if (!SHA256_RE.test(nodeSha)) die('internal error: node.exe digest malformed', 3);
  const bootSha = await sha256File(bootstrapDest);
  if (!SHA256_RE.test(bootSha)) die('internal error: bootstrap.cjs digest malformed', 3);

  const allFiles = [nodeDest, bootstrapDest, ...(await walk(undiciDest))];
  const entries = [];
  for (const p of allFiles) {
    const st = await fs.stat(p);
    entries.push({ path: p, sha256: await sha256File(p), size: st.size });
  }

  const manifest = {
    schemaVersion: 1,
    nodePath: nodeDest,
    bootstrapPath: bootstrapDest,
    undiciDir: undiciDest,
    nodeSha256: nodeSha,
    bootstrapSha256: bootSha,
    entries,
  };
  const manifestPath = path.join(targetDir, 'runtime.manifest.json');
  await writeAtomic(manifestPath, JSON.stringify(manifest, null, 2) + '\n');
  return { manifestPath, nodeDest, bootstrapDest, undiciDest, nodeSha, bootSha, entries };
}

// ---------------------------------------------------------------------------
// Path A: full build (cl.exe + all runtime inputs present)
// ---------------------------------------------------------------------------

async function buildFull(cl, targetDir) {
  // Runtime-closure inputs — fail-closed before compiling anything so a
  // missing runtime never leaves compiled exes without their manifest.
  await requireFile(BOOTSTRAP_PATH, 'Committed at images/runtime/bootstrap.cjs.');
  if (!existsSync(UNDICI_DIR)) {
    die(
      `vendored undici not found at ${UNDICI_DIR}\n` +
      '  Run `node scripts/vendor-undici.mjs` first (pinned against images.lock.json).',
    );
  }
  await requireFile(IMAGES_LOCK_PATH, 'Committed at images/images.lock.json.');
  const nodeSrcPath = process.execPath; // trusted Node runtime on the Windows host
  await requireFile(nodeSrcPath, 'process.execPath — the Node running this script.');

  // Compile both C sources.
  const helperObj = path.join(targetDir, 'octopus-sandbox-helper.obj');
  const gateSvcObj = path.join(targetDir, 'octopus-sandbox-gate-svc.obj');
  await compileObj(cl, HELPER_SRC, helperObj);
  await compileObj(cl, GATE_SVC_SRC, gateSvcObj);

  // Link both executables.
  const helperExe = path.join(targetDir, 'octopus-sandbox-helper.exe');
  const gateSvcExe = path.join(targetDir, 'octopus-sandbox-gate-svc.exe');
  await linkExe(cl, helperObj, helperExe);
  await linkExe(cl, gateSvcObj, gateSvcExe);

  // Per-artifact manifests.
  await writePerArtifactManifest(
    `${helperExe}.manifest.json`,
    await manifestEntryFor(helperExe),
    { kind: 'win-helper-c', file: 'src/windows/helper.c' },
  );
  await writePerArtifactManifest(
    `${gateSvcExe}.manifest.json`,
    await manifestEntryFor(gateSvcExe),
    { kind: 'win-gate-svc-c', file: 'src/windows/gate-svc.c' },
  );

  // Runtime closure manifest (consumable by verifyWindowsRuntimeManifest).
  const rt = await writeRuntimeManifest(targetDir, nodeSrcPath);

  // Clean up intermediate .obj files — they are not shipped artifacts and
  // leaving them around invites confusion with the .compile-ok marker.
  await fs.rm(helperObj, { force: true }).catch(() => {});
  await fs.rm(gateSvcObj, { force: true }).catch(() => {});

  console.log('build-win-helper: OK (full build)');
  console.log(`  helper:    ${helperExe}`);
  console.log(`  gate-svc:  ${gateSvcExe}`);
  console.log(`  runtime:   ${rt.manifestPath}`);
  console.log(`  node.exe:  sha256=${rt.nodeSha}`);
}

// ---------------------------------------------------------------------------
// Path B: compile-only smoke (cl.exe present, runtime closure inputs absent)
// ---------------------------------------------------------------------------

async function buildCompileOnly(cl, targetDir) {
  const tmpObj = path.join(
    os.tmpdir(),
    `octopus-sandbox-helper-${process.pid}-${Date.now()}.obj`,
  );
  try {
    await execFileAsync(cl, [
      '/nologo', '/c', '/W4', '/WX', '/O2', '/std:c17',
      `/Fo${tmpObj}`,
      HELPER_SRC,
    ]);
  } catch (err) {
    await fs.rm(tmpObj, { force: true }).catch(() => {});
    die(
      `compile-only smoke failed: ${err.stderr ?? err.stdout ?? err.message}\n` +
      '  helper.c must compile under MSVC /std:c17 /W4 /WX.',
    );
  }
  const objSha = await sha256File(tmpObj);
  const objSt = await fs.stat(tmpObj);
  await fs.rm(tmpObj, { force: true }).catch(() => {});

  const marker = {
    schemaVersion: 1,
    kind: 'compile-only-smoke',
    sourceSha256: await sha256File(HELPER_SRC),
    objectSha256: objSha,
    objectSize: objSt.size,
    note: 'helper.c compiles under MSVC /std:c17 /W4 /WX. Full link + runtime ' +
          'closure awaits the Windows runtime inputs (node.exe, bootstrap.cjs, ' +
          'vendored undici). No runnable octopus-sandbox-helper.exe was produced.',
  };
  const markerPath = path.join(targetDir, 'octopus-sandbox-helper.compile-ok');
  await writeAtomic(markerPath, JSON.stringify(marker, null, 2) + '\n');

  console.log('build-win-helper: OK (compile-only smoke)');
  console.log(`  source:   ${HELPER_SRC}`);
  console.log(`  object:   sha256=${objSha} size=${objSt.size}`);
  console.log(`  marker:   ${markerPath}`);
  console.log(
    '  NOTE: full link against the Windows runtime closure was NOT performed —\n' +
    '  one or more runtime inputs are missing. No runnable .exe was produced;\n' +
    '  this only proves the C source compiles.',
  );
}

// ---------------------------------------------------------------------------
// Entry point — only runs when executed directly, never on import.
// ---------------------------------------------------------------------------

async function main() {
  if (process.platform !== 'win32') {
    die(
      `unsupported host platform '${process.platform}' — build-win-helper targets ${TARGET_PLATFORM_ARCH} ` +
      'and must run on a Windows host with MSVC (cl.exe). Cross-compile lanes are not wired yet.',
    );
  }
  if (process.arch !== 'x64') {
    die(`unsupported host arch '${process.arch}' — expected x64 (${TARGET_PLATFORM_ARCH}).`);
  }

  await requireFile(HELPER_SRC, 'Task 7 creates src/windows/helper.c.');
  await requireFile(GATE_SVC_SRC, 'Task 8 creates src/windows/gate-svc.c.');

  const cl = await findCl();
  if (!cl) {
    die(
      "required tool 'cl.exe' not found — install Visual Studio Build Tools with the " +
      "'MSVC v143 - VS 2022 C++ x64/x86 build tools' component, or run from a " +
      "'x64 Native Tools Command Prompt'.",
    );
  }
  console.log(`build-win-helper: cl.exe = ${cl}`);

  const targetDir = path.join(PKG_ROOT, 'prebuilds', TARGET_PLATFORM_ARCH);
  await fs.mkdir(targetDir, { recursive: true });

  const haveRuntimeInputs =
    existsSync(BOOTSTRAP_PATH) && existsSync(UNDICI_DIR) && existsSync(IMAGES_LOCK_PATH);
  if (haveRuntimeInputs) {
    await buildFull(cl, targetDir);
  } else {
    await buildCompileOnly(cl, targetDir);
  }
}

const invokedDirectly = (() => {
  const argv1 = process.argv[1];
  if (!argv1) return false;
  try {
    return path.resolve(argv1) === path.resolve(fileURLToPath(import.meta.url));
  } catch {
    return false;
  }
})();

if (invokedDirectly) {
  main().catch((err) => {
    die(err?.message ?? String(err));
  });
}
