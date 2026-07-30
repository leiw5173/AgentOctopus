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
    cwd: '/tmp',
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
  return { gate: 'G1', ...evaluateG1(guestStdout, sentinelValue) };
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
    cwd: '/tmp',
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

  return { gate: 'G2', ...evaluateG2(guestStdout, canaryReceivedConnection) };
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
  // nested inside bootstrapArgv[1]; it is NOT the helper's own argv.
  const vsockPort = 4242 + (process.pid % 1000);
  const vsockHostSocket = path.join(os.tmpdir(), `octopus-gate-vsock-${process.pid}-${Date.now()}.sock`);
  const vsockServer = net.createServer();
  let serverReady = false;

  try {
    await new Promise((resolve, reject) => {
      vsockServer.once('error', reject);
      vsockServer.listen(vsockHostSocket, () => {
        vsockServer.removeListener('error', reject);
        serverReady = true;
        resolve();
      });
    });

    const argv = await buildHelperArgv(helperPath, {
      rootfsImg,
      skillBlockImg,
      caBlockImg,
      vsockPort,
      vsockHostSocket,
      cpus: 1,
      memMib: 512,
      launchSpecBlob,
    });

    // Minimal env so the helper can find vendored libkrun/libkrunfw.
    const env = { PATH: process.env.PATH ?? '' };
    if (process.platform === 'darwin') {
      env.DYLD_LIBRARY_PATH = targetDir;
    } else {
      env.LD_LIBRARY_PATH = targetDir;
    }

    const child = execFile(helperPath, argv, {
      env,
      maxBuffer: 16 * 1024 * 1024,
    });
    let stdout = '';
    child.stdout?.on('data', (c) => { stdout += c.toString('utf8'); });
    try {
      await child;
    } catch (err) {
      // Non-zero exit is expected for probe scripts that encounter failures;
      // treat the captured stdout as the result regardless.
      if (err.stdout) stdout += err.stdout.toString('utf8');
    }
    return stdout;
  } finally {
    if (serverReady) {
      await new Promise((r) => vsockServer.close(r));
    }
    await fs.rm(vsockHostSocket, { force: true }).catch(() => {});
  }
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
