import { runDocker } from './cli.js';

export class NetworkError extends Error {
  constructor(m: string) { super(m); this.name = 'NetworkError'; }
}

/** Create an --internal network (no outbound internet route). Returns network id. */
export async function createInternalNetwork(name: string): Promise<string> {
  const res = await runDocker(['network', 'create', '--internal', name]);
  if (res.code !== 0) throw new NetworkError(`failed to create network ${name}: ${res.stderr.trim()}`);
  return res.stdout.trim();
}

/**
 * Derive a per-session /24 subnet from the egress network name.
 *
 * Docker only honors a user-specified `--ip` on container attach when the
 * network was created with an explicit `--subnet` ("user specified IP address
 * is supported only when connecting to networks with user configured
 * subnets"), so the egress bridge cannot use Docker's auto-assigned subnet.
 *
 * The security tests run multiple files concurrently under the same daemon
 * (vitest parallelizes at the file level), each creating its own egress
 * network. A single fixed subnet would collide ("Pool overlaps with other
 * one on this address space"). The network name carries a per-session random
 * hex token (`octopus-sbx-<sessionId>-egress`), so we hash that token into a
 * unique `10.b.c.0/24` inside the 10.0.0.0/8 private space — far from Docker's
 * default 172.17-172.29 auto-allocation pool, and distinct per session.
 */
function deriveEgressSubnet(networkName: string): string {
  const match = networkName.match(/octopus-sbx-([0-9a-f]+)-egress/);
  const token = match?.[1] ?? networkName;
  // FNV-1a over the token -> two octets. Cheap, deterministic, well-spread.
  let h = 0x811c9dc5;
  for (let i = 0; i < token.length; i++) {
    h ^= token.charCodeAt(i);
    h = Math.imul(h, 0x01000193);
  }
  const second = (h >>> 8) & 0xff;
  const third = (h >>> 0) & 0xff;
  return `10.${second}.${third}.0/24`;
}

/** Create the trusted ordinary bridge used only by the proxy sidecar for upstream egress (NOT --internal). Returns network id. */
export async function createEgressNetwork(name: string): Promise<string> {
  const res = await runDocker(['network', 'create', '--subnet', deriveEgressSubnet(name), name]);
  if (res.code !== 0) throw new NetworkError(`failed to create egress network ${name}: ${res.stderr.trim()}`);
  return res.stdout.trim();
}

/** Attach a container (the proxy sidecar) to a network with an optional alias; never used to attach the runtime to the egress bridge. */
export async function connectNetwork(name: string, containerName: string, alias?: string): Promise<void> {
  const args = ['network', 'connect'];
  if (alias) args.push('--alias', alias);
  args.push(name, containerName);
  const res = await runDocker(args);
  if (res.code !== 0) throw new NetworkError(`failed to connect ${containerName} to ${name}: ${res.stderr.trim()}`);
}

/** Detach a container from a network; idempotent (ignores not-connected). */
export async function disconnectNetwork(name: string, containerName: string): Promise<void> {
  const res = await runDocker(['network', 'disconnect', '-f', name, containerName]);
  if (res.code !== 0 && !/not found|No such|not connected/i.test(res.stderr)) {
    throw new NetworkError(`failed to disconnect ${containerName} from ${name}: ${res.stderr.trim()}`);
  }
}

/** Remove a network; idempotent (ignores not-found). */
export async function removeNetwork(name: string): Promise<void> {
  const res = await runDocker(['network', 'rm', name]);
  if (res.code !== 0 && !/not found|No such network/i.test(res.stderr)) {
    throw new NetworkError(`failed to remove network ${name}: ${res.stderr.trim()}`);
  }
}

export async function networkExists(name: string): Promise<boolean> {
  const res = await runDocker(['network', 'inspect', name, '--format', '{{.Id}}']);
  return res.code === 0 && res.stdout.trim().length > 0;
}
