import { spawn, type ChildProcess } from 'node:child_process';
import { EgressProxy } from './egress-proxy.js';
import { SessionCa, writeCaBundle } from './ca.js';
import { createOneShotSecretWriter } from './secret-channel.js';
import { runDocker, waitForContainerRunning } from '../docker/cli.js';
import { connectNetwork, disconnectNetwork } from '../docker/network.js';
import type { SandboxPolicy } from '../policy.js';
import type { ResolvedSecrets } from './egress-proxy.js';
import type { ProxyCarrier } from '../backend.js';

export interface ProxyHandle {
  readonly reachableAddr: string;
  readonly caBundlePath: string;
  close(): Promise<void>;
}

export interface ProxyLauncher {
  launch(
    opts: { policy: SandboxPolicy; secrets: ResolvedSecrets; workDir: string },
    carrier: ProxyCarrier,
  ): Promise<ProxyHandle>;
}

/** Fixed in-network port the Docker sidecar listens on. */
const DOCKER_PROXY_PORT = 8080;

/** Build pure/testable Docker launch arguments (no secrets in argv). */
export function buildDockerLaunchArgs(carrier: Extract<ProxyCarrier, { kind: 'docker-sidecar' }>): string[] {
  const containerName = `octopus-proxy-${Math.random().toString(36).slice(2, 10)}`;
  return [
    'run', '--rm', '-i',
    '--name', containerName,
    '--network', carrier.internalNetwork,
    '--network-alias', carrier.reachableHost,
    carrier.proxyImage,
  ];
}

/** Build pure/testable Linux-static launch arguments (no secrets in argv). */
export function buildLinuxLaunchArgs(carrier: Extract<ProxyCarrier, { kind: 'linux-static' }>): string[] {
  return [
    'node', carrier.binaryPath,
    '--listen-host', carrier.listenHost,
    '--listen-port', String(carrier.listenPort),
    '--namespace-path', carrier.skillNamespace.path,
    '--cgroup-path', carrier.cgroupPath,
  ];
}

export class DefaultProxyLauncher implements ProxyLauncher {
  async launch(
    opts: { policy: SandboxPolicy; secrets: ResolvedSecrets; workDir: string },
    carrier: ProxyCarrier,
  ): Promise<ProxyHandle> {
    // Create the ONE session CA for this execution
    const ca = SessionCa.create();
    let caBundlePath: string | undefined;
    let proxy: EgressProxy | undefined;
    let child: ChildProcess | undefined;
    let dockerContainerName: string | undefined;
    let dockerCarrier: Extract<ProxyCarrier, { kind: 'docker-sidecar' }> | undefined;
    let closed = false;

    const cleanup = async (): Promise<void> => {
      if (closed) return;
      closed = true;
      ca.destroy();
      if (proxy) await proxy.close().catch(() => {});
      if (child && child.exitCode === null) {
        child.kill('SIGTERM');
        await new Promise<void>((resolve) => {
          child!.once('close', () => resolve());
          setTimeout(resolve, 5_000);
        });
      }
      if (dockerCarrier && dockerContainerName) {
        await runDocker(['rm', '-f', dockerContainerName]).catch(() => {});
        await disconnectNetwork(dockerCarrier.egressNetwork, dockerContainerName).catch(() => {});
        await disconnectNetwork(dockerCarrier.internalNetwork, dockerContainerName).catch(() => {});
      }
    };

    try {
      caBundlePath = await writeCaBundle(opts.workDir, ca);

      switch (carrier.kind) {
        case 'in-process': {
          proxy = new EgressProxy({
            policy: opts.policy,
            secrets: opts.secrets,
            ca,
          });
          const port = await proxy.listen(0, carrier.listenHost);
          return {
            reachableAddr: `http://${carrier.reachableHost}:${port}`,
            caBundlePath,
            close: cleanup,
          };
        }

        case 'docker-sidecar': {
          dockerCarrier = carrier;
          const writer = createOneShotSecretWriter({ secrets: opts.secrets, ca });
          const containerName = `octopus-proxy-${Math.random().toString(36).slice(2, 10)}`;
          dockerContainerName = containerName;

          const args = [
            'run', '--rm', '-i',
            '--name', containerName,
            '--network', carrier.internalNetwork,
            '--network-alias', carrier.reachableHost,
            '-e', 'OCTOPUS_PROXY_SECRET_FD=0',
            '-e', `OCTOPUS_PROXY_SECRET_NONCE=${writer.nonce}`,
            '-e', `OCTOPUS_PROXY_CONFIG=${JSON.stringify({ listenHost: '0.0.0.0', listenPort: DOCKER_PROXY_PORT, policy: opts.policy })}`,
            carrier.proxyImage,
          ];

          child = spawn('docker', args, { stdio: ['pipe', 'pipe', 'pipe'] });

          // Write the one-shot secret frame to stdin, then close stdin
          await writer.writeTo(child.stdin!);

          // `docker run` returns before the daemon registers the container as
          // running; an immediate `network connect` races the daemon and fails
          // with "No such container". Wait for the running state first.
          await waitForContainerRunning(containerName);

          // Attach ONLY the proxy sidecar to the egress network
          await connectNetwork(carrier.egressNetwork, containerName);

          // Wait for ready message on stdout
          await waitForReady(child, 15_000);

          return {
            reachableAddr: `http://${carrier.reachableHost}:${DOCKER_PROXY_PORT}`,
            caBundlePath,
            close: cleanup,
          };
        }

        case 'linux-static': {
          const args = buildLinuxLaunchArgs(carrier);
          const writer = createOneShotSecretWriter({ secrets: opts.secrets, ca });

          child = spawn(args[0]!, args.slice(1), {
            stdio: ['ignore', 'pipe', 'pipe', 'pipe'],
            env: {
              OCTOPUS_PROXY_SECRET_FD: '3',
              OCTOPUS_PROXY_SECRET_NONCE: writer.nonce,
              OCTOPUS_PROXY_CONFIG: JSON.stringify({
                listenHost: carrier.listenHost,
                listenPort: carrier.listenPort,
                policy: opts.policy,
              }),
            },
          });

          // Write the one-shot frame to fd 3
          const fd3 = child.stdio[3] as NodeJS.WritableStream;
          await writer.writeTo(fd3);

          // Wait for ready message on stdout
          await waitForReady(child, 15_000);

          return {
            reachableAddr: `http://${carrier.reachableHost}:${carrier.listenPort}`,
            caBundlePath,
            close: cleanup,
          };
        }
      }
    } catch (err) {
      await cleanup();
      throw err;
    }
  }
}

async function waitForReady(child: ChildProcess, timeoutMs: number): Promise<number> {
  return new Promise((resolve, reject) => {
    let buf = '';
    const timer = setTimeout(() => {
      child.stdout!.removeListener('data', onData);
      reject(new Error('timeout waiting for proxy ready'));
    }, timeoutMs);

    const onData = (chunk: Buffer) => {
      buf += chunk.toString();
      try {
        const parsed = JSON.parse(buf.trim()) as { ready?: boolean; boundPort?: number };
        if (parsed.ready && typeof parsed.boundPort === 'number') {
          clearTimeout(timer);
          child.stdout!.removeListener('data', onData);
          resolve(parsed.boundPort);
        }
      } catch {
        // not yet complete JSON
      }
    };
    child.stdout!.on('data', onData);
    child.once('error', (err) => {
      clearTimeout(timer);
      reject(err);
    });
    child.once('close', (code) => {
      clearTimeout(timer);
      reject(new Error(`proxy exited before ready (code ${code})`));
    });
  });
}
