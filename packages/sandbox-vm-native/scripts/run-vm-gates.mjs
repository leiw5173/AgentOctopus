#!/usr/bin/env node
/**
 * run-vm-gates.mjs — G1/G2 qualification gates + gate-manifest emission.
 *
 * Runs the two adversarial escape-matrix gates that qualify a VM TCB lane
 * for release, then writes prebuilds/<platform>/gate-manifest.json:
 *
 *   G1 (host-file-unreachable): start a qualification VM with a minimal
 *     rootfs + a fixture skill block image; inside the guest, attempt reads
 *     of host canary paths (/etc/passwd, ~/.ssh/id_*). GO when ALL host-path
 *     reads FAIL — proving the virtiofs rootfs/skill mounts are the only
 *     filesystems the guest can see, and host files are not reachable.
 *
 *   G2 (network-canary-unreachable): open a canary TCP listener on the host;
 *     start a VM with the pinned TSI-DISABLED start sequence (NO virtio-net,
 *     NO passt, NO gv-proxy — the helper's mass-close + zero-netif sequence);
 *     inside the guest attempt AF_INET connect to the host canary + to
 *     1.1.1.1:80. GO when the canary receives NOTHING and 1.1.1.1 FAILS —
 *     proving the guest has no network path to the host or the internet.
 *
 * The gate manifest lists qualifiedRootfsDigests[] (the rootfs byte refs
 * produced by build-vm-rootfs.mjs, Task 15 — linux-arm64 + linux-x64) and
 * the artifact digests (libkrun/libkrunfw/helper/imageBuilder) read from
 * the combined vm-tcb-manifest.json. manifestDigest is computed via
 * computeManifestDigest (gate-manifest.ts, Task 7). The manifest is then
 * signed by sign-release-manifest.mjs (Step 2) into the outer release
 * manifest.
 *
 * This script is a Linux release-lane producer (it boots a real libkrun VM).
 * FAIL-CLOSED on non-Linux hosts — macOS cannot run the libkrun VM. The
 * script is also fail-closed if any prerequisite artifact (rootfs, libs,
 * helper) is missing: a lane cannot be qualified without a complete TCB.
 *
 * Usage: node scripts/run-vm-gates.mjs --step gate
 *   (the --step flag is reserved for future multi-step qualification flows;
 *    currently the only valid value is `gate`.)
 */
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { createHash } from 'node:crypto';
import { createReadStream, existsSync } from 'node:fs';
import fs from 'node:fs/promises';
import net from 'node:net';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import {
  BOOTSTRAP_PATH,
  buildG1ProbeScript,
  buildG2ProbeScript,
  buildHelperArgv,
  evaluateG1,
  evaluateG2,
} from './vm-gate-eval.mjs';
import { readArtifactRefsFromTcbManifest, TCB_MANIFEST_NAME } from './tcb-manifest.mjs';

const execFileAsync = promisify(execFile);

// Control + rootfs fd slots the helper expects (must match vm-helper.c
// H2G_READ_FD / G2H_WRITE_FD / ROOTFS_INHERIT_FD and engine.ts). The gate
// spawns the helper directly (not through the engine), so it must wire these
// itself — see bootVmAndCaptureStdout.
const H2G_READ_FD = 3;
const G2H_WRITE_FD = 4;
const ROOTFS_INHERIT_FD = 5;
const DUPFD_MIN = 10;

// Lazily-loaded native-binding FD helpers (createNativeDeps / fdToReadable /
// fdToWritable) from the built dist. Loaded on first use so the module-level
// import graph of this script stays free of the dist-build requirement (the
// gates already fail closed later if dist is missing, via buildHelperArgv).
let nativeFd;
async function loadNativeFd() {
  if (nativeFd) return nativeFd;
  const bindingPath = path.join(PKG_ROOT, 'dist', 'native-binding.js');
  if (!existsSync(bindingPath)) {
    die(`native-binding not found at ${bindingPath}\n` +
      '  Run `pnpm --filter @agentoctopus/sandbox-vm-native build` first.');
  }
  const mod = await import(bindingPath);
  if (typeof mod.createNativeDeps !== 'function' ||
      typeof mod.fdToReadable !== 'function' ||
      typeof mod.fdToWritable !== 'function') {
    die('native-binding.js did not export createNativeDeps/fdToReadable/fdToWritable.');
  }
  nativeFd = mod;
  return nativeFd;
}

/** Open the verified rootfs image read-only (no symlink follow), for fd 5.
 *  Returns the FileHandle (NOT just handle.fd): the caller must own and
 *  explicitly close() it. Returning only the raw fd drops the FileHandle, and
 *  modern Node treats a GC-collected FileHandle as an error (it closes the fd
 *  underneath the parent's independent raw-fd lifecycle management). */
async function openRootfsReadOnly(rootfsImg) {
  return fs.open(rootfsImg, 'r');
}

/** Close a FileHandle, ignoring already-closed errors. */
async function closeHandle(handle) {
  if (!handle) return;
  try { await handle.close(); } catch { /* already closed */ }
}

/** Close a raw fd, ignoring already-closed errors. */
async function closeFd(fd) {
  if (typeof fd !== 'number' || fd < 0) return;
  try { await fs.close(fd); } catch { /* already closed */ }
}

const HERE = path.dirname(fileURLToPath(import.meta.url));
const PKG_ROOT = path.resolve(HERE, '..');
const PREBUILDS_DIR = path.join(PKG_ROOT, 'prebuilds');

const SHA256_RE = /^[0-9a-f]{64}$/;
const SHA256_REF_RE = /^sha256:[0-9a-f]{64}$/;

function die(msg, exitCode = 1) {
  console.error(`run-vm-gates: ERROR: ${msg}`);
  process.exit(exitCode);
}

function platformArch() {
  const platform = process.platform;
  const arch = process.arch;
  if (platform === 'darwin' && arch === 'arm64') return 'darwin-arm64';
  if (platform === 'linux' && arch === 'x64') return 'linux-x64';
  die(
    `unsupported host '${platform}-${arch}' — VM gates run on darwin-arm64 ` +
    `and linux-x64 lanes only. The guest VM cannot boot on this host.`,
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

// Read a per-artifact TCB manifest (libkrun.manifest.json etc.) and return
// the artifact digest as `sha256:<hex>` (the gate manifest stores refs, not
// bare hex). Returns null if the manifest file is absent.
async function readArtifactRef(manifestPath) {
  if (!existsSync(manifestPath)) return null;
  const raw = JSON.parse(await fs.readFile(manifestPath, 'utf8'));
  const sha = raw?.artifact?.sha256 ?? raw?.sha256;
  if (typeof sha !== 'string' || !SHA256_RE.test(sha)) return null;
  return 'sha256:' + sha;
}

// ---------------------------------------------------------------------------
// G1: host-file-unreachable.
//
// Strategy: boot the qualification VM (sandbox-vm-helper with the minimal
// rootfs + a fixture skill block image), then issue a launch spec that runs
// a guest command attempting to read host canary paths. The guest's view
// is ONLY the virtiofs mounts (rootfs vda + skill vdb + ca vdc); /etc/passwd
// inside the guest is the ROOTFS's /etc/passwd (an empty skeleton dir from
// build-vm-rootfs.mjs), NOT the host's. ~/.ssh does not exist in the guest
// at all. So a successful G1 = every canary path read returns ENOENT/EACCES
// (i.e. the guest CANNOT see the host's /etc/passwd or ~/.ssh/id_*).
//
// We assert the NEGATIVE: none of the host canary contents appear in the
// guest's read attempts. A precomputed host canary sentinel (a unique marker
// written to a tmp file on the host BEFORE the gate) proves the guest did
// not reach it.
// ---------------------------------------------------------------------------

const HOST_CANARY_PATHS = ['/etc/passwd', '/etc/shadow', '/root/.ssh/id_rsa', '/root/.ssh/id_ed25519'];

async function runGateG1(targetDir, helperPath, rootfsImg, rootfsRef, skillBlockImg, caBlockImg) {
  console.log('run-vm-gates: G1 (host-file-unreachable)...');

  // Write a unique host canary sentinel. If the guest can read it, G1 fails.
  const hostSentinelDir = path.join(os.tmpdir(), `octopus-g1-sentinel-${process.pid}-${Date.now()}`);
  await fs.mkdir(hostSentinelDir, { recursive: true });
  const sentinelPath = path.join(hostSentinelDir, 'canary.txt');
  const sentinelValue = `OCTOPUS-G1-${process.pid}-${Date.now()}-${cryptoRandomHex(16)}`;
  await fs.writeFile(sentinelPath, sentinelValue, { mode: 0o600 });
  // Add the sentinel path to the canary set the guest must NOT reach.
  const canaryPaths = [...HOST_CANARY_PATHS, sentinelPath];

  // Direct-Node probe: run /usr/bin/node -e "<script>" inside the guest.
  // The script uses node:fs to attempt reads of host canary paths. It emits
  // the sentinel value only if actually read, then emits G1-DONE.
  const probeScript = buildG1ProbeScript(canaryPaths, sentinelValue);
  const { blob: launchSpecBlob } = await buildLaunchSpec({
    executable: '/usr/bin/node',
    argv: ['/usr/bin/node', '-e', probeScript],
    // vm-init enforces cwd resolves under /skill (R7: the workload's root is
    // the read-only skill block image). The probe doesn't need /skill content,
    // but its cwd must still satisfy that constraint — use /skill, not /tmp.
    cwd: '/skill',
    env: [],
    allowedExecutables: { '/usr/bin/node': '/usr/bin/node' },
  });

  let guestStdout = '';
  try {
    guestStdout = await bootVmAndCaptureStdout({
      targetDir, helperPath, rootfsImg, skillBlockImg, caBlockImg, launchSpecBlob,
    });
  } catch (err) {
    await fs.rm(hostSentinelDir, { recursive: true, force: true }).catch(() => {});
    return { gate: 'G1', status: 'NO-GO', reason: `VM boot failed: ${err.message}` };
  }

  await fs.rm(hostSentinelDir, { recursive: true, force: true }).catch(() => {});
  const result = evaluateG1(guestStdout, sentinelValue);
  // On helper early-exit the DONE marker is absent and the real boot failure
  // sits in the helper's stderr (captured into guestStdout by
  // bootVmAndCaptureStdout). Surface it so a NO-GO is diagnosable.
  if (result.status === 'NO-GO' && !guestStdout.includes('G1-DONE')) {
    console.error(`run-vm-gates: G1 helper output (early-exit):\n${guestStdout.trim() || '(no output)'}`);
  }
  return { gate: 'G1', ...result };
}

// ---------------------------------------------------------------------------
// G2: network-canary-unreachable.
//
// Strategy: open a TCP listener on the host on an ephemeral port (the
// canary). Boot the VM with the TSI-DISABLED start sequence (the helper's
// pinned 13-step sequence — NO virtio-net/passt/gvproxy, mass-close before
// any krun_* call). Inside the guest, attempt AF_INET connect to (a) the
// host canary's address and (b) 1.1.1.1:80. G2 GO iff the canary receives
// ZERO connections AND 1.1.1.1 connect fails — proving the guest has no
// network path.
// ---------------------------------------------------------------------------

async function runGateG2(targetDir, helperPath, rootfsImg, rootfsRef, skillBlockImg, caBlockImg) {
  console.log('run-vm-gates: G2 (network-canary-unreachable)...');

  // Host canary listener. Records whether ANY connection arrived.
  let canaryReceivedConnection = false;
  const canary = net.createServer((socket) => {
    canaryReceivedConnection = true;
    socket.destroy();
  });
  const canaryPort = await new Promise((resolve, reject) => {
    canary.once('error', reject);
    canary.listen(0, '127.0.0.1', () => resolve(canary.address().port));
  });
  // The host IP the guest would try to reach. The guest has no netif, so
  // this is the theoretical target; the gate asserts it's unreachable.
  const hostCanaryAddr = '127.0.0.1';

  // Direct-Node probe: run /usr/bin/node -e "<script>" inside the guest.
  // The script uses node:net to attempt TCP connects. It emits CONNECT-OK*
  // only on successful connects, then emits G2-DONE.
  const probeScript = buildG2ProbeScript(hostCanaryAddr, canaryPort);
  const { blob: launchSpecBlob } = await buildLaunchSpec({
    executable: '/usr/bin/node',
    argv: ['/usr/bin/node', '-e', probeScript],
    // cwd must resolve under /skill (vm-init's R7 constraint) — see G1 above.
    cwd: '/skill',
    env: [],
    allowedExecutables: { '/usr/bin/node': '/usr/bin/node' },
  });

  let guestStdout = '';
  try {
    guestStdout = await bootVmAndCaptureStdout({
      targetDir, helperPath, rootfsImg, skillBlockImg, caBlockImg, launchSpecBlob,
    });
  } catch (err) {
    canary.close();
    return { gate: 'G2', status: 'NO-GO', reason: `VM boot failed: ${err.message}` };
  }

  // Give the canary a moment to drain any in-flight connection callbacks.
  await new Promise((r) => setTimeout(r, 100));
  canary.close();

  const result = evaluateG2(guestStdout, canaryReceivedConnection);
  if (result.status === 'NO-GO' && !guestStdout.includes('G2-DONE')) {
    console.error(`run-vm-gates: G2 helper output (early-exit):\n${guestStdout.trim() || '(no output)'}`);
  }
  return { gate: 'G2', ...result };
}

// ---------------------------------------------------------------------------
// Launch-spec + VM boot scaffolding.
//
// These helpers construct the launch spec (Task 3's CBOR+base64url encoding)
// and invoke sandbox-vm-helper (Task 11) to boot the VM. The helper's FD
// plumbing (R9/R10) and the vm-init decode (Task 12) are exercised end-to-
// end here — this is the L3 integration point.
//
// On macOS this cannot run (no libkrun VM); the script fails closed before
// reaching here on non-Linux. On Linux, the helper binary must exist and
// the TCB must verify.
// ---------------------------------------------------------------------------

async function buildLaunchSpec(spec) {
  // Delegate to the sandbox package's launch-spec encoder (Task 3). Deep
  // import the dist build — same pattern as build-vm-helper.mjs's verifyVmTcb
  // import. If the dist is not built, fail closed.
  const launchSpecPath = path.join(PKG_ROOT, '..', 'sandbox', 'dist', 'vm', 'launch-spec.js');
  if (!existsSync(launchSpecPath)) {
    die(`launch-spec encoder not found at ${launchSpecPath}\n` +
      '  Run `pnpm --filter @agentoctopus/sandbox build` first.');
  }
  const mod = await import(launchSpecPath);
  const encode = mod.encodeLaunchSpec ?? mod.default;
  if (typeof encode !== 'function') {
    die('launch-spec encoder did not export encodeLaunchSpec.');
  }
  return encode(spec);
}

async function bootVmAndCaptureStdout({ targetDir, helperPath, rootfsImg, skillBlockImg, caBlockImg, launchSpecBlob }) {
  // Build the helper launch spec (base64url JSON) and invoke the helper with
  // [helperPath, helperSpecToken]. The guest's per-probe launch spec blob is
  // the sole bootstrapArgv entry (guest argv[1]); it is NOT the helper's own argv.
  const vsockPort = 4242 + (process.pid % 1000);
  const vsockHostSocket = path.join(os.tmpdir(), `octopus-gate-vsock-${process.pid}-${Date.now()}.sock`);
  const vsockServer = net.createServer();
  let serverReady = false;

  await new Promise((resolve, reject) => {
    vsockServer.once('error', reject);
    vsockServer.listen(vsockHostSocket, () => {
      vsockServer.removeListener('error', reject);
      serverReady = true;
      resolve();
    });
  });

  // --- Pre-boot diagnostic: is the helper + libkrun loadable WITHOUT entering
  // the hypervisor? `--has-blk` runs the helper's BLK-probe subcommand, which
  // resolves dyld + links libkrun/libkrunfw and calls krun_has_feature but
  // NEVER calls krun_start_enter (no HVF access). The full boot dies with
  // SIGKILL (exit 137) and ZERO userspace output, so we cannot tell whether
  // the kill is (a) the helper/dylibs being unloaded or (b) the kernel
  // rejecting the ad-hoc hypervisor entitlement at HVF entry. This probe
  // separates them: exit 0/1 here => the binary + libs load fine, so 137 at
  // boot = HVF-entitlement kill; SIGKILL here => the helper itself can't load.
  let probeInfo = 'has-blk probe: not run';
  try {
    const probeEnv = { PATH: process.env.PATH ?? '' };
    if (process.platform === 'darwin') probeEnv.DYLD_LIBRARY_PATH = targetDir;
    else probeEnv.LD_LIBRARY_PATH = targetDir;
    const probeRes = await new Promise((resolve) => {
      execFile(helperPath, ['--has-blk'], { env: probeEnv, timeout: 15_000 }, (err, stdout, stderr) => {
        if (!err) return resolve({ tag: 'exit 0 (BLK supported)', stdout, stderr });
        resolve({
          tag: `code=${err.code ?? 'n/a'} signal=${err.signal ?? 'none'}`,
          stdout: stdout ?? '',
          stderr: stderr ?? '',
        });
      });
    });
    probeInfo = `has-blk probe: ${probeRes.tag}` +
      (probeRes.stderr?.trim() ? ` stderr=${probeRes.stderr.trim().slice(0, 160)}` : '');
  } catch (err) {
    probeInfo = `has-blk probe threw: ${err.message}`;
  }

  // --- Control + rootfs fd plumbing (mirrors engine.ts start(), R9/R10). ---
  // The helper REQUIRES three inherited fds and silently no-ops without them:
  //   fd 3 (H2G_READ_FD)      — host→guest control read end
  //   fd 4 (G2H_WRITE_FD)     — guest→host console write end (the guest probe's
  //                             console.log('G1-DONE') is relayed HERE, not to
  //                             the helper's own stdout)
  //   fd 5 (ROOTFS_INHERIT_FD)— the verified rootfs image, referenced in the
  //                             spec as /dev/fd/5
  // A plain execFile leaves 3/4/5 as inherited handles (typically /dev/null),
  // so the helper boots, writes the guest console to nowhere, opens the WRONG
  // rootfs inode, and exits 0 with empty captured stdout — the exact NO-GO
  // "helper early-exit, no output" the lane hit. Spawn via deps.spawn with the
  // same file_actions the engine installs, and read the guest output from fd 4.
  const { createNativeDeps, fdToReadable, fdToWritable } = await loadNativeFd();
  const deps = createNativeDeps();
  const [h2gRead, h2gWrite] = await deps.pipe(); // host→guest
  const [g2hRead, g2hWrite] = await deps.pipe(); // guest→host (fd 4 in helper)
  const rootfsHandle = await openRootfsReadOnly(rootfsImg);
  const rootfsFd = rootfsHandle.fd;

  let raw;
  try {
    // Move the ends the helper owns to cloexec temp slots >=10 so the adddup2
    // into 3/4/5 is a REAL dup2 (clears FD_CLOEXEC on the target), never a
    // no-op that would leave the cloexec bit set and drop the fd across exec.
    const tempH2gRead = await deps.dupFdCloexec(h2gRead, DUPFD_MIN);
    const tempG2hWrite = await deps.dupFdCloexec(g2hWrite, DUPFD_MIN);
    const tempRootfs = await deps.dupFdCloexec(rootfsFd, DUPFD_MIN);

    const fileActions = [
      { kind: 'adddup2', src: tempH2gRead, target: H2G_READ_FD },
      { kind: 'adddup2', src: tempG2hWrite, target: G2H_WRITE_FD },
      { kind: 'adddup2', src: tempRootfs, target: ROOTFS_INHERIT_FD },
    ];
    // Darwin closes every other inherited fd across exec; Linux relies on the
    // per-end cloexec bits plus the dup2'd 3/4/5 surviving.
    const spawnAttrFlags = process.platform === 'darwin' ? ['POSIX_SPAWN_CLOEXEC_DEFAULT'] : [];
    // After spawn the parent closes ITS copies of the ends the helper now owns
    // (h2gRead→3, g2hWrite→4, rootfs→5) plus the temp slots. The parent RETAINS
    // g2hRead (reads guest console), h2gWrite (control), and its own rootfsFd.
    const parentCloseFds = [h2gRead, g2hWrite, tempH2gRead, tempG2hWrite, tempRootfs];

    // Minimal env so the helper can find vendored libkrun/libkrunfw. The
    // vendored dylibs carry bare/@rpath install names; *_LIBRARY_PATH is
    // consulted before rpath resolution, pointing the loader at targetDir.
    // OCT_VM_HELPER_KRUN_DEBUG raises libkrun's log level so a krun_start_enter
    // EINVAL prints WHICH config element libkrun rejects (diagnosing gate boot
    // failures); it only adds stderr output, never changes behavior.
    const env = { PATH: process.env.PATH ?? '', OCT_VM_HELPER_KRUN_DEBUG: '1' };
    if (process.platform === 'darwin') {
      env.DYLD_LIBRARY_PATH = targetDir;
    } else {
      env.LD_LIBRARY_PATH = targetDir;
    }
    const argv = await buildHelperArgv(helperPath, {
      rootfsImg: `/dev/fd/${ROOTFS_INHERIT_FD}`,
      skillBlockImg,
      caBlockImg,
      vsockPort,
      vsockHostSocket,
      cpus: 1,
      memMib: 512,
      launchSpecBlob,
    });

    raw = await deps.spawn(helperPath, argv, env, fileActions, spawnAttrFlags, parentCloseFds);
  } catch (err) {
    // Spawn (or fd setup) failed — close every parent fd and surface the error
    // so the gate records a real boot failure, not a silent empty-output NO-GO.
    await closeHandle(rootfsHandle);
    await closeFd(h2gRead);
    await closeFd(h2gWrite);
    await closeFd(g2hRead);
    await closeFd(g2hWrite);
    if (serverReady) await new Promise((r) => vsockServer.close(r));
    await fs.rm(vsockHostSocket, { force: true }).catch(() => {});
    throw new Error(`helper spawn failed: ${err.message}`);
  }

  // Guest console = fd 4 (g2hRead); helper's own stdout/stderr = fd 1/2.
  const controlRead = fdToReadable(g2hRead);
  const h2gWriteStream = fdToWritable(h2gWrite);
  let guestOut = '';
  let helperStdout = '';
  let helperStderr = '';
  controlRead.on('data', (c) => { guestOut += c.toString('utf8'); });
  raw.stdout?.on('data', (c) => { helperStdout += c.toString('utf8'); });
  raw.stderr?.on('data', (c) => { helperStderr += c.toString('utf8'); });

  // Fail-closed per-boot timeout: a healthy boot -> probe -> guest halt takes
  // only a few seconds. If the guest never halts (krun_start_enter does not
  // return), do NOT hang the lane forever -- declare a TIMEOUT and let the
  // finally block's raw.close() SIGKILL the helper. The captured output (which
  // accumulates into helperStdout/helperStderr regardless of how the boot ends)
  // is still returned below, so a TIMEOUT remains diagnosable. A TIMEOUT is a
  // boot defect, not a pass.
  const BOOT_TIMEOUT_MS = 90_000;
  let exitInfo = 'exit: unknown';
  let bootTimer;
  try {
    const timeout = new Promise((resolve) => {
      bootTimer = setTimeout(() => resolve({ __bootTimeout: true }), BOOT_TIMEOUT_MS);
      bootTimer.unref?.();
    });
    const result = await Promise.race([raw.exited, timeout]);
    if (result && result.__bootTimeout) {
      exitInfo = `exit: TIMEOUT after ${BOOT_TIMEOUT_MS / 1000}s (guest never halted; helper killed)`;
    } else {
      exitInfo = `exit: ${result.exitCode}`;
    }
  } catch (err) {
    exitInfo = `exit error: ${err.message}`;
  } finally {
    clearTimeout(bootTimer);
    // Drain any trailing console bytes, then release the parent's retained fds.
    await new Promise((r) => setTimeout(r, 50));
    controlRead.destroy();
    h2gWriteStream.destroy();
    await closeFd(g2hRead);
    await closeFd(h2gWrite);
    await closeHandle(rootfsHandle);
    await raw.close?.().catch(() => {});
    if (serverReady) await new Promise((r) => vsockServer.close(r));
    await fs.rm(vsockHostSocket, { force: true }).catch(() => {});
  }

  // The workload's stdio is relayed via the "krun-stdio" named virtio-console
  // port: the helper registers it on the octopus-control multiport device with
  // output fd 6 (the helper's stdout pipe, dup2'd by native-binding's spawn
  // file actions) and input fd 7, and vm-init opens the port by name and dup2's
  // it onto the workload's fd 0/1/2 before execve. (A named port is required:
  // krun_start_enter takes over fd 0/1, and krun_set_console_output to a
  // /dev/fd/N alias drops the bytes.) So G1-DONE/G2-DONE, any leaked sentinel,
  // and any CONNECT-OK marker land in helperStdout (raw, on the stdout channel).
  // The control port (fd 4 -> guestOut) carries ONLY the bootstrap ready/error
  // frame. Return all three streams, LABELED, so the evaluators see the workload
  // output AND a NO-GO still shows the bootstrap reason / helper exit status —
  // and so the CI log reveals which stream the markers rode (stdout == clean).
  const tail = [];
  tail.push(`[helper ${exitInfo}]`);
  tail.push(`[${probeInfo}]`);
  if (!guestOut.trim()) {
    tail.push('[guest control console (fd 4) empty — no ready/error frame relayed]');
  }
  return [
    '--- guest control console (fd 4 -> ready/error frame) ---',
    guestOut,
    '--- helper stdout (stdout pipe; workload stdio via the krun-stdio named port) ---',
    helperStdout,
    '--- helper stderr (fd 2 -> libkrun logger) ---',
    helperStderr,
    ...tail,
  ].join('\n');
}

function cryptoRandomHex(bytes) {
  return createHash('sha256').update(crypto.randomUUID()).digest('hex').slice(0, bytes * 2);
}

// ---------------------------------------------------------------------------
// Assemble + write the gate manifest.
// ---------------------------------------------------------------------------

async function emitGateManifest(targetDir, platform, g1Result, g2Result, qualifiedRootfsDigests, artifactRefs) {
  // computeManifestDigest: sha256 over canonical JSON of the body EXCLUDING
  // the manifestDigest field (gate-manifest.ts:28-31). We inline the same
  // algorithm so this producer does not depend on the sandbox dist build
  // being present JUST for the digest (we already depend on it for the
  // launch-spec encoder, but the digest is the manifest's integrity root —
  // inline it for clarity and to match the test's exact algorithm).
  const body = {
    platform,
    schemaVersion: 1,
    artifacts: {
      libkrun: artifactRefs.libkrun,
      libkrunfw: artifactRefs.libkrunfw,
      helper: artifactRefs.helper,
      imageBuilder: artifactRefs.imageBuilder,
    },
    qualifiedRootfsDigests,
    libkrunAbi: 'v1.19.4',
    blkFeatureRequired: true,
    gates: { G1: g1Result.status, G2: g2Result.status },
    gateReasons: [g1Result.reason, g2Result.reason].filter(Boolean),
    qualifiedAt: new Date().toISOString(),
  };
  const manifestDigest = 'sha256:' + createHash('sha256').update(JSON.stringify(body)).digest('hex');
  const manifest = { ...body, manifestDigest };

  const manifestPath = path.join(targetDir, 'gate-manifest.json');
  await writeAtomic(manifestPath, JSON.stringify(manifest, null, 2) + '\n');
  return { manifest, manifestPath };
}

// ---------------------------------------------------------------------------
// Main
// ---------------------------------------------------------------------------

// --step gate (only valid value currently).
const stepIdx = process.argv.indexOf('--step');
const step = stepIdx >= 0 ? process.argv[stepIdx + 1] : 'gate';
if (step !== 'gate') die(`unknown --step '${step}' (expected 'gate').`);

const platform = platformArch();
if (process.platform !== 'linux' && process.platform !== 'darwin') {
  die(`unsupported platform ${process.platform}`);
}

const targetDir = path.join(PREBUILDS_DIR, platform);
await fs.mkdir(targetDir, { recursive: true });

// Prerequisite artifact gate: a lane cannot be qualified without a
// complete TCB. Each artifact must exist with its per-artifact manifest.
const helperPath = path.join(targetDir, 'sandbox-vm-helper');
const libkrunPath = path.join(targetDir, process.platform === 'darwin' ? 'libkrun.dylib' : 'libkrun.so');
const libkrunfwPath = path.join(targetDir, process.platform === 'darwin' ? 'libkrunfw.dylib' : 'libkrunfw.so');
const imageBuilderPath = path.join(targetDir, 'vm-image-builder');

for (const [name, p] of [['helper', helperPath], ['libkrun', libkrunPath], ['libkrunfw', libkrunfwPath], ['imageBuilder', imageBuilderPath]]) {
  if (!existsSync(p)) {
    die(`prerequisite artifact '${name}' not found at ${p}\n` +
      `  Run \`pnpm --filter @agentoctopus/sandbox-vm-native security:build-vm\` first.`);
  }
}

// Read artifact refs from the combined vm-tcb-manifest.json. Fail closed if
// the combined manifest is missing or any entry is malformed.
const tcbManifestPath = path.join(targetDir, TCB_MANIFEST_NAME);
let artifactRefs;
try {
  artifactRefs = await readArtifactRefsFromTcbManifest(tcbManifestPath);
} catch (err) {
  die(`combined TCB manifest missing or malformed: ${err.message}\n` +
    '  Run security:build-vm first to produce vm-tcb-manifest.json with all four artifacts.');
}

// Qualified rootfs digests: collect the refs from every rootfs.manifest.json
// present across the prebuilds/ dirs (Task 15 produces linux-arm64 + linux-x64).
const qualifiedRootfsDigests = [];
for (const dir of await fs.readdir(PREBUILDS_DIR, { withFileTypes: true })) {
  if (!dir.isDirectory()) continue;
  const rootfsManifest = path.join(PREBUILDS_DIR, dir.name, 'rootfs.manifest.json');
  if (!existsSync(rootfsManifest)) continue;
  const ref = await readArtifactRef(rootfsManifest);
  if (ref && SHA256_REF_RE.test(ref) && !qualifiedRootfsDigests.includes(ref)) {
    qualifiedRootfsDigests.push(ref);
  }
}
if (qualifiedRootfsDigests.length === 0) {
  die('no qualified rootfs found — run build-vm-rootfs.mjs first (Task 15).');
}

// The qualification VM uses the matching-platform rootfs + a fixture skill
// block image. The fixture is a tiny ext4 with a single /probe.sh that the
// gate's launch spec execve's; built ad-hoc via vm-image-builder single-file
// mode (Task 13 — small enough to fit the C writer's 8 MiB limit).
const rootfsImg = path.join(targetDir, 'rootfs.img');
if (!existsSync(rootfsImg)) {
  die(`qualification rootfs not found at ${rootfsImg}`);
}
const rootfsRef = (await readArtifactRef(path.join(targetDir, 'rootfs.manifest.json')));
if (!rootfsRef) die('rootfs.manifest.json missing ref');

// Build the fixture skill block image (single-file mode). The probe script
// is written to a tmp file, then sealed into a tiny ext4 via vm-image-builder.
const fixtureScriptPath = path.join(os.tmpdir(), `octopus-gate-probe-${process.pid}-${Date.now()}.sh`);
const fixtureImg = path.join(targetDir, '.gate-fixture.img');
await fs.writeFile(fixtureScriptPath, '#!/bin/sh\necho gate-probe-ready\n', { mode: 0o755 });

// Build a matching fixture CA block image (the helper spec requires three
// block devices: rootfs vda, skill vdb, CA vdc). Content is irrelevant for
// the gates; the image just needs to be a valid sealed ext4 block.
const caFixturePath = path.join(os.tmpdir(), `octopus-gate-ca-${process.pid}-${Date.now()}.pem`);
const caFixtureImg = path.join(targetDir, '.gate-ca-fixture.img');
await fs.writeFile(caFixturePath, 'stub-ca-cert\n', { mode: 0o644 });

try {
  await execFileAsync(imageBuilderPath, ['single-file', fixtureScriptPath, 'probe.sh', 'sha256:' + await sha256File(fixtureScriptPath), fixtureImg]);
  await execFileAsync(imageBuilderPath, ['single-file', caFixturePath, 'ca.pem', 'sha256:' + await sha256File(caFixturePath), caFixtureImg]);
} catch (err) {
  await fs.rm(fixtureScriptPath, { force: true }).catch(() => {});
  await fs.rm(fixtureImg, { force: true }).catch(() => {});
  await fs.rm(caFixturePath, { force: true }).catch(() => {});
  await fs.rm(caFixtureImg, { force: true }).catch(() => {});
  die(`fixture block image build failed: ${err.stderr ?? err.message}`);
}
await fs.rm(fixtureScriptPath, { force: true }).catch(() => {});
await fs.rm(caFixturePath, { force: true }).catch(() => {});

// Run G1 + G2.
const g1 = await runGateG1(targetDir, helperPath, rootfsImg, rootfsRef, fixtureImg, caFixtureImg);
console.log(`  G1: ${g1.status} — ${g1.reason}`);
const g2 = await runGateG2(targetDir, helperPath, rootfsImg, rootfsRef, fixtureImg, caFixtureImg);
console.log(`  G2: ${g2.status} — ${g2.reason}`);

await fs.rm(fixtureImg, { force: true }).catch(() => {});
await fs.rm(caFixtureImg, { force: true }).catch(() => {});

// Emit gate manifest (regardless of GO/NO-GO — a NO-GO manifest is itself
// auditable, and verifyGateManifest rejects NO-GO gates at launch time).
const { manifest, manifestPath } = await emitGateManifest(
  targetDir, platform, g1, g2, qualifiedRootfsDigests, artifactRefs,
);
console.log(`run-vm-gates: gate-manifest emitted at ${manifestPath}`);
console.log(`  manifestDigest: ${manifest.manifestDigest}`);
console.log(`  G1: ${manifest.gates.G1}, G2: ${manifest.gates.G2}`);
console.log(`  qualifiedRootfsDigests: ${manifest.qualifiedRootfsDigests.length}`);

if (g1.status !== 'GO' || g2.status !== 'GO') {
  console.error('run-vm-gates: GATE FAILED — lane NOT qualified. The gate manifest records the NO-GO.');
  console.error('  Sign the manifest only if you are intentionally recording a failed qualification.');
  process.exit(2);
}

console.log('run-vm-gates: OK — lane qualified (G1=GO, G2=GO).');
console.log('  Next: sign the gate manifest with sign-release-manifest.mjs.');
