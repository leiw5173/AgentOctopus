/**
 * Shared granted-upstream fixture for the Docker egress lanes.
 *
 * Starts a root runtime-image container on the egress network serving the plain
 * text 'ok' on :80 with a static IP, so a lane can grant that exact egress-network
 * IP literal and assert the runtime reaches it ONLY via the proxy.
 *
 * Leaf-clean: Node stdlib + this package's own docker cli + the Task 1 harness.
 */

import { randomUUID } from 'node:crypto';
import { runDocker } from '../../src/docker/cli.js';
import { requirePinnedImageRef } from './harness.js';

/** Find a free static IPv4 address inside a network's first subnet. */
async function pickStaticIp(network: string): Promise<string> {
  const inspect = JSON.parse((await runDocker(['network', 'inspect', network])).stdout)[0];
  const subnet: string = inspect.IPAM?.Config?.[0]?.Subnet;
  if (!subnet) throw new Error(`no subnet for network ${network}`);
  // Take the network base and choose a high host octet unlikely to collide.
  const base = subnet.split('/')[0]!;
  const parts = base.split('.').map(Number);
  parts[3] = 200;
  return parts.join('.');
}

/** Start the granted-upstream fixture: a root runtime-image container on the egress net serving 'ok' on :80. */
export async function startEgressUpstream(egressNetwork: string): Promise<{ name: string; ip: string }> {
  const name = `octopus-upstream-${randomUUID().slice(0, 8)}`;
  const ip = await pickStaticIp(egressNetwork);
  // Root so it can bind :80. This is a test fixture, not the security boundary.
  const serve =
    'require("node:http").createServer((q,s)=>{s.writeHead(200,{"content-type":"text/plain"});s.end("ok")}).listen(80,"0.0.0.0")';
  const runtimeImage = requirePinnedImageRef('runtime', process.env.OCTOPUS_TEST_RUNTIME_IMAGE!);
  const res = await runDocker([
    'run', '-d', '--name', name,
    '--network', egressNetwork, '--ip', ip,
    '--user', '0',
    runtimeImage, 'node', '-e', serve,
  ]);
  if (res.code !== 0) throw new Error(`failed to start upstream fixture: ${res.stderr.trim()}`);
  // Wait for the listener.
  const deadline = Date.now() + 15_000;
  for (;;) {
    const probe = await runDocker(['exec', name, 'node', '-e',
      'require("node:net").connect(80,"127.0.0.1").on("connect",()=>process.exit(0)).on("error",()=>process.exit(1))']);
    if (probe.code === 0) break;
    if (Date.now() > deadline) throw new Error('upstream fixture did not start listening');
    await new Promise((r) => setTimeout(r, 150));
  }
  return { name, ip };
}
