#!/usr/bin/env node
import fs from 'node:fs';
import { EgressProxy } from './proxy/egress-proxy.js';
import { SessionCa } from './proxy/ca.js';
import { readOneShotSecrets } from './proxy/secret-channel.js';
import type { SandboxPolicy } from './policy.js';
import type { ExplicitTargetGrant } from './proxy/policy-engine.js';

interface ProxyConfig {
  listenHost: string;
  listenPort: number;
  policy: SandboxPolicy;
  explicitTargets?: ExplicitTargetGrant[];
}

function fail(msg: string, code = 1): never {
  console.error(`egress-proxy-server: ${msg}`);
  process.exit(code);
}

async function main(): Promise<void> {
  const configJson = process.env.OCTOPUS_PROXY_CONFIG;
  if (!configJson) fail('OCTOPUS_PROXY_CONFIG is required');

  let config: ProxyConfig;
  try {
    config = JSON.parse(configJson) as ProxyConfig;
  } catch {
    fail('OCTOPUS_PROXY_CONFIG is not valid JSON');
  }

  const fdStr = process.env.OCTOPUS_PROXY_SECRET_FD;
  const nonce = process.env.OCTOPUS_PROXY_SECRET_NONCE;
  if (!fdStr) fail('OCTOPUS_PROXY_SECRET_FD is required');
  if (!nonce) fail('OCTOPUS_PROXY_SECRET_NONCE is required');

  const fd = Number(fdStr);
  if (!Number.isInteger(fd) || fd < 0) fail('OCTOPUS_PROXY_SECRET_FD must be a non-negative integer');

  // Read the one-shot secret frame BEFORE binding/listening.
  const stream = fs.createReadStream('', { fd, autoClose: true });
  const { secrets, sessionCa } = await readOneShotSecrets(stream, nonce, 15_000);

  // Reconstruct the launcher-provisioned CA — NEVER create a new one.
  const ca = SessionCa.fromEnvelope(sessionCa);

  const proxy = new EgressProxy({
    policy: config.policy,
    secrets,
    ca,
    explicitTargets: config.explicitTargets,
  });

  const boundPort = await proxy.listen(config.listenPort, config.listenHost);

  // Ready channel: no secrets, no CA private material.
  process.stdout.write(JSON.stringify({ ready: true, boundPort }) + '\n');

  const shutdown = async (signal: string) => {
    await proxy.close().catch(() => {});
    process.exit(0);
  };

  process.on('SIGTERM', () => void shutdown('SIGTERM'));
  process.on('SIGINT', () => void shutdown('SIGINT'));
}

main().catch((err) => {
  console.error('egress-proxy-server: fatal', err instanceof Error ? err.message : String(err));
  process.exit(1);
});
