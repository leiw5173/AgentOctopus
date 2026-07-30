/**
 * vm-gate-eval.mjs — pure, VM-free helpers for the G1/G2 qualification gates.
 *
 * This module is imported by both the producer (run-vm-gates.mjs) and its unit
 * test. It deliberately contains no top-level side effects so importing it for
 * tests never triggers a VM boot.
 */
import { existsSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const HERE = path.dirname(fileURLToPath(import.meta.url));
const PKG_ROOT = path.resolve(HERE, '..');

/** Guest bootstrap path — must match VmSandboxBackend.BOOTSTRAP_PATH. */
export const BOOTSTRAP_PATH = '/usr/libexec/octopus-vm-init';

/**
 * G1 evaluator: GO only when the guest emitted the G1-DONE marker AND the host
 * sentinel value never leaked into stdout. Fail-closed on missing marker
 * (helper early-exit, empty stdout, etc.) or any sentinel presence.
 */
export function evaluateG1(stdout, sentinelValue) {
  const hasDone = stdout.includes('G1-DONE');
  const leaked = stdout.includes(sentinelValue);
  if (!hasDone) {
    return {
      status: 'NO-GO',
      reason: 'probe did not execute (helper early-exit): G1-DONE marker absent',
    };
  }
  if (leaked) {
    return {
      status: 'NO-GO',
      reason: 'host sentinel value leaked into guest stdout — host filesystem reachable',
    };
  }
  return { status: 'GO', reason: 'all host canary paths unreadable from guest' };
}

/**
 * G2 evaluator: GO only when the guest emitted G2-DONE, no CONNECT-OK marker
 * appeared in stdout, and the host canary listener received no connection.
 */
export function evaluateG2(stdout, canaryReceivedConnection) {
  const hasDone = stdout.includes('G2-DONE');
  const anyConnectOk = stdout.includes('CONNECT-OK');
  if (canaryReceivedConnection) {
    return {
      status: 'NO-GO',
      reason: 'host canary received a connection from the guest',
    };
  }
  if (anyConnectOk) {
    return {
      status: 'NO-GO',
      reason: 'guest connected to 1.1.1.1:80 — outbound network reachable',
    };
  }
  if (!hasDone) {
    return {
      status: 'NO-GO',
      reason: 'probe did not execute (helper early-exit): G2-DONE marker absent',
    };
  }
  return { status: 'GO', reason: 'guest could not reach host canary or 1.1.1.1' };
}

/**
 * Build the direct-Node G1 probe script. The launch spec runs:
 *   /usr/bin/node -e "<script>"
 *
 * The script uses node:fs to attempt reads of each canary path. It emits the
 * sentinel value only if it is actually read from the guest, and always emits
 * G1-DONE at the end.
 */
export function buildG1ProbeScript(canaryPaths, sentinelValue) {
  return `
const fs = require('node:fs');
const sentinel = ${JSON.stringify(sentinelValue)};
const paths = ${JSON.stringify(canaryPaths)};
for (const p of paths) {
  try {
    const data = fs.readFileSync(p, 'utf8');
    if (data.includes(sentinel)) console.log(sentinel);
  } catch (e) {
    console.log('NOT-FOUND');
  }
}
console.log('G1-DONE');
`.trim();
}

/**
 * Build the direct-Node G2 probe script. The launch spec runs:
 *   /usr/bin/node -e "<script>"
 *
 * The script uses node:net to attempt TCP connects to the host canary and to
 * 1.1.1.1:80. It emits CONNECT-OK-CANARY / CONNECT-OK only on successful
 * connects, then emits G2-DONE.
 */
export function buildG2ProbeScript(hostAddr, port) {
  return `
const net = require('node:net');
function tryConnect(host, port, label) {
  return new Promise((resolve) => {
    const socket = net.connect(port, host, () => {
      console.log(label);
      socket.destroy();
      resolve();
    });
    socket.on('error', () => {
      console.log('CONNECT-FAIL');
      resolve();
    });
    socket.setTimeout(2000, () => {
      socket.destroy();
      console.log('CONNECT-FAIL');
      resolve();
    });
  });
}
(async () => {
  await tryConnect(${JSON.stringify(hostAddr)}, ${port}, 'CONNECT-OK-CANARY');
  await tryConnect('1.1.1.1', 80, 'CONNECT-OK');
  console.log('G2-DONE');
})();
`.trim();
}

/**
 * Build the helper argv for sandbox-vm-helper.
 *
 * Returns [helperPath, helperSpecToken] where helperSpecToken is the
 * base64url(JSON) helper launch spec consumed by vm-helper.c argv[1]. The
 * guest's per-probe launch spec blob is nested inside bootstrapArgv[1]; the
 * helper-spec's bootstrapPath matches bootstrapArgv[0].
 */
export async function buildHelperArgv(
  helperPath,
  {
    rootfsImg,
    skillBlockImg,
    caBlockImg,
    vsockPort,
    vsockHostSocket,
    cpus,
    memMib,
    launchSpecBlob,
    trustedEnv = [],
  },
) {
  const helperLaunchSpecPath = path.join(PKG_ROOT, 'dist', 'helper-launch-spec.js');
  if (!existsSync(helperLaunchSpecPath)) {
    throw new Error(
      `sandbox-vm-native dist is missing at ${helperLaunchSpecPath}. ` +
      'Run `pnpm --filter @agentoctopus/sandbox-vm-native build` first.',
    );
  }
  const mod = await import(/* @vite-ignore */ helperLaunchSpecPath);
  const buildHelperLaunchSpec = mod.buildHelperLaunchSpec;
  if (typeof buildHelperLaunchSpec !== 'function') {
    throw new Error('helper-launch-spec.js did not export buildHelperLaunchSpec');
  }

  const config = {
    rootfsArtifact: {
      ref: '',
      absolutePath: rootfsImg,
      manifestDigest: '',
      size: 0,
      mode: 0,
    },
    skillBlockImage: {
      ref: '',
      absolutePath: skillBlockImg,
      manifestDigest: '',
      size: 0,
      mode: 0,
    },
    caBlockImage: {
      ref: '',
      absolutePath: caBlockImg,
      manifestDigest: '',
      size: 0,
      mode: 0,
    },
    bootstrapPath: BOOTSTRAP_PATH,
    bootstrapArgv: [BOOTSTRAP_PATH, launchSpecBlob],
    vsockPort,
    vsockHostSocket,
    cpus,
    memMib,
    readyTimeoutMs: 0,
    libkrunAbi: 'v1.19.4',
  };
  const token = buildHelperLaunchSpec(config, trustedEnv);
  return [helperPath, token];
}
