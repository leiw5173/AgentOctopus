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
 * Fixed subnet for the egress bridge. Docker only honors a user-specified
 * `--ip` on container attach when the network was created with an explicit
 * `--subnet` ("user specified IP address is supported only when connecting to
 * networks with user configured subnets"). The topology tests attach the
 * upstream fixture with a static `.200` IP, so the egress network must carry
 * a user-configured subnet. 10.201.0.0/24 is a private range outside Docker's
 * default 172.17-172.29 auto-allocation pool, avoiding overlap with the
 * default bridge and other auto-created user networks.
 */
const EGRESS_SUBNET = '10.201.0.0/24';

/** Create the trusted ordinary bridge used only by the proxy sidecar for upstream egress (NOT --internal). Returns network id. */
export async function createEgressNetwork(name: string): Promise<string> {
  const res = await runDocker(['network', 'create', '--subnet', EGRESS_SUBNET, name]);
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
