#!/usr/bin/env node
/**
 * security-probe-linux.mjs — run Plan 4's real privileged capability probe
 * (`probeOsCaps()`) against the real runtime/helper artifacts.
 *
 * With `--require`, exits non-zero unless `fullLevel(caps) === 'full'`.
 *
 * CI-ONLY: this needs a privileged Linux host (netns/nft/cgroup-v2) and the
 * produced artifacts (packages/sandbox/runtime/*.manifest.json). On macOS
 * `probeOsCaps()` short-circuits to a restricted OsCaps (every capability bit
 * false), so `--require` correctly exits non-zero with a forwarded reason —
 * that is the intended fail-closed behavior, not a bug.
 *
 * The probe DELEGATES to probeOsCaps(); it never re-implements netns/veth/nft/
 * cgroup probing.
 */
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const HERE = path.dirname(fileURLToPath(import.meta.url));
const PKG_ROOT = path.resolve(HERE, '..');
const RUNTIME_DIR = path.join(PKG_ROOT, 'runtime');
const RUNTIME_MANIFEST = path.join(RUNTIME_DIR, 'linux-node22.manifest.json');
const HELPER_MANIFEST = path.join(RUNTIME_DIR, 'os-helper.manifest.json');
const DIST_PROBE = path.join(PKG_ROOT, 'dist', 'os', 'probe.js');

const requireFull = process.argv.includes('--require');

function out(obj) {
  console.log(JSON.stringify(obj, null, 2));
}

async function main() {
  // Manifests are produced by scripts/build-runtime-rootfs.mjs and
  // scripts/build-os-helper.mjs on the Linux release lane (gitignored).
  const missing = [];
  if (!fs.existsSync(RUNTIME_MANIFEST)) missing.push(RUNTIME_MANIFEST);
  if (!fs.existsSync(HELPER_MANIFEST)) missing.push(HELPER_MANIFEST);

  if (missing.length > 0) {
    const reason = `probeOsCaps unavailable: manifest(s) not present: ${missing.join(', ')}`;
    out({ available: false, full: false, reason });
    if (requireFull) {
      console.error(`security-probe-linux: ${reason}`);
      process.exit(1);
    }
    return;
  }

  let probeOsCaps, fullLevel;
  try {
    ({ probeOsCaps, fullLevel } = await import(DIST_PROBE));
  } catch (err) {
    const reason = `cannot import compiled probe at ${DIST_PROBE} (run \`pnpm --filter @agentoctopus/sandbox build\` first): ${err.message}`;
    out({ available: false, full: false, reason });
    if (requireFull) {
      console.error(`security-probe-linux: ${reason}`);
      process.exit(1);
    }
    return;
  }

  let caps;
  try {
    caps = await probeOsCaps({ runtimeManifestPath: RUNTIME_MANIFEST, helperManifestPath: HELPER_MANIFEST });
  } catch (err) {
    const reason = `probeOsCaps threw: ${err.message ?? err}`;
    out({ available: false, full: false, reason });
    if (requireFull) {
      console.error(`security-probe-linux: ${reason}`);
      process.exit(1);
    }
    return;
  }

  const full = fullLevel(caps) === 'full';
  out({
    available: full,
    full,
    platform: caps.platform,
    caps: {
      userMountPidIpcUtsNs: caps.userMountPidIpcUtsNs,
      namedNetns: caps.namedNetns,
      nftRuleCreate: caps.nftRuleCreate,
      cgroupV2Writable: caps.cgroupV2Writable,
      runtimeArtifact: caps.runtimeArtifact,
      helperArtifact: caps.helperArtifact,
      sandboxExec: caps.sandboxExec,
    },
    probeErrors: caps.probeErrors,
  });

  if (requireFull && !full) {
    const reason = caps.probeErrors.length > 0
      ? caps.probeErrors.join('; ')
      : `fullLevel=restricted (platform=${caps.platform})`;
    console.error(`security-probe-linux: privileged Linux capability NOT full — ${reason}`);
    process.exit(1);
  }
}

main().catch((err) => {
  console.error(`security-probe-linux: ERROR: ${err instanceof Error ? err.message : String(err)}`);
  process.exit(1);
});
