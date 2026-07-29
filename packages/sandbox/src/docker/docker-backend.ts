import { randomUUID } from 'node:crypto';
import { PassThrough } from 'node:stream';
import { spawn as spawnChild, type ChildProcess } from 'node:child_process';
import type {
  SandboxBackend,
  BackendPrepareOptions,
  ExecSpec,
  SpawnSpec,
  SandboxProcess,
  BackendRunResult,
  ProxyCarrier,
} from '../backend.js';
import { ContainmentCleanupError } from '../backend.js';
import type { SandboxConfig } from '../schema.js';
import { ImmutableImageRefSchema, SNAPSHOT_DIGEST_RE } from '../schema.js';
import { parseByteSize, parseCpuCount, parseTimeoutMs } from '../policy.js';
import { runDocker, dockerAvailable } from './cli.js';
import { createInternalNetwork, createEgressNetwork, removeNetwork } from './network.js';

export function buildDockerArgs(input: {
  config: SandboxConfig;
  prepare: BackendPrepareOptions;
  spec: ExecSpec;
  networkName: string;
  containerName: string;
}): string[] {
  const { config, prepare, spec, networkName, containerName } = input;
  const dcfg = config.docker;
  if (!dcfg) throw new Error('DockerBackend requires sandbox.docker config');
  const image = ImmutableImageRefSchema.parse(prepare.runtimeProfile.dockerImage);
  const memoryBytes = Math.min(prepare.resources.memoryBytes, parseByteSize(dcfg.memory));
  const cpus = Math.min(prepare.resources.cpus, parseCpuCount(dcfg.cpus));

  const args = ['run', '--rm', '-i', '--name', containerName, '--network', networkName];
  args.push('--read-only', '--tmpfs', '/tmp:rw,noexec,nosuid,size=64m');
  // Use --mount (not -v): the content-addressed snapshotRoot contains a colon
  // (`<store>/sha256:<hex>`), which -v parses as a field separator and rejects
  // with "too many colons". --mount splits on commas, so a colon in the source
  // path is preserved.
  args.push('--mount', `type=bind,source=${prepare.snapshotRoot},target=${prepare.guestSkillRoot},readonly`);
  args.push('--mount', `type=bind,source=${prepare.caBundlePath},target=${prepare.guestCaBundlePath},readonly`);
  args.push('-w', prepare.guestSkillRoot, '--user', '65534:65534');
  args.push('--memory', String(memoryBytes), '--cpus', String(cpus));
  args.push('--pids-limit', String(dcfg.pids));
  args.push('--ulimit', `nofile=${dcfg.ulimits.nofile}`);
  args.push('--ulimit', `fsize=${parseByteSize(dcfg.ulimits.fsize)}`);
  args.push('--cap-drop', 'ALL', '--security-opt', 'no-new-privileges');
  for (const [k, v] of Object.entries(spec.env ?? {})) args.push('-e', `${k}=${v}`);
  // Trusted env pushed AFTER spec.env so trusted values win on collision (Docker last-wins).
  args.push('-e', `HTTP_PROXY=${prepare.proxyAddr}`, '-e', `HTTPS_PROXY=${prepare.proxyAddr}`);
  args.push('-e', `SSL_CERT_FILE=${prepare.guestCaBundlePath}`);
  args.push('-e', `NODE_EXTRA_CA_CERTS=${prepare.guestCaBundlePath}`);
  args.push('-e', `REQUESTS_CA_BUNDLE=${prepare.guestCaBundlePath}`);
  args.push(image, ...spec.command);
  return args;
}

export class DockerBackend implements SandboxBackend {
  readonly kind = 'docker' as const;
  readonly isolationLevel = 'full' as const;
  private readonly sessionId: string;
  private readonly internalNetwork: string;
  private readonly egressNetwork: string;
  private readonly runtimeContainer: string;
  private readonly proxyContainer: string;
  private carrier?: Extract<ProxyCarrier, { kind: 'docker-sidecar' }>;
  private opts?: BackendPrepareOptions;
  private cleaned = false;
  /**
   * Memoized FIRST cleanup outcome (T3 contract). Once set, repeat cleanup()
   * calls rethrow the same ContainmentCleanupError or resolve identically.
   */
  private cleanupOutcome: { error?: ContainmentCleanupError } | undefined;
  private readonly runDockerImpl: typeof runDocker;
  private readonly removeNetworkImpl: typeof removeNetwork;

  constructor(
    private readonly input: {
      config: SandboxConfig;
      sessionId?: string;
      /**
       * Test-only DI seam (T3). Production callers omit this. The seam lets
       * unit tests drive cleanup semantics (containment vs soft) without a
       * real Docker daemon.
       */
      deps?: {
        runDocker?: typeof runDocker;
        removeNetwork?: typeof removeNetwork;
      };
    },
  ) {
    this.sessionId = input.sessionId ?? randomUUID().slice(0, 8);
    this.internalNetwork = `octopus-sbx-${this.sessionId}-internal`;
    this.egressNetwork = `octopus-sbx-${this.sessionId}-egress`;
    this.runtimeContainer = `octopus-sbx-runtime-${this.sessionId}`;
    this.proxyContainer = `octopus-sbx-proxy-${this.sessionId}`;
    this.runDockerImpl = input.deps?.runDocker ?? runDocker;
    this.removeNetworkImpl = input.deps?.removeNetwork ?? removeNetwork;
  }

  async probe(): Promise<boolean> { return dockerAvailable(); }

  async prepareTopology(): Promise<ProxyCarrier> {
    if (this.carrier) return this.carrier;
    const config = this.input.config;
    if (!config.docker || !config.proxy) throw new Error('Docker topology requires docker and proxy config');
    ImmutableImageRefSchema.parse(config.docker.image);
    const proxyImage = ImmutableImageRefSchema.parse(config.proxy.artifact);
    try {
      await createInternalNetwork(this.internalNetwork);
      await createEgressNetwork(this.egressNetwork);
      this.carrier = {
        kind: 'docker-sidecar', proxyImage,
        internalNetwork: this.internalNetwork, egressNetwork: this.egressNetwork,
        reachableHost: 'egress-proxy',
      };
      return this.carrier;
    } catch (error) {
      await this.cleanup();
      throw error;
    }
  }

  async prepare(opts: BackendPrepareOptions): Promise<void> {
    const carrier = this.carrier;
    if (!carrier) throw new Error('prepareTopology() must run before prepare()');
    if (opts.guestSkillRoot !== '/skill' || opts.guestCaBundlePath !== '/etc/skill-ca/ca.pem') {
      throw new Error('invalid canonical guest mount paths');
    }
    if (new URL(opts.proxyAddr).hostname !== carrier.reachableHost) throw new Error('proxy carrier mismatch');
    // Assert the expected snapshot digest FORMAT. The runner owns the full
    // byte-for-byte re-verify (verifySnapshot runs immediately before
    // backend.prepare); the backend only gates on the canonical
    // `sha256:<64 lowercase hex>` shape so a malformed/missing digest can
    // never reach a mount.
    if (!SNAPSHOT_DIGEST_RE.test(opts.expectedSnapshotDigest)) {
      throw new Error('DockerBackend.prepare: expectedSnapshotDigest must match sha256:<64 lowercase hex>');
    }
    ImmutableImageRefSchema.parse(opts.runtimeProfile.dockerImage);
    parseTimeoutMs(opts.resources.timeoutMs);
    if (!Number.isSafeInteger(opts.resources.memoryBytes) || opts.resources.memoryBytes <= 0) throw new Error('invalid memory');
    if (!Number.isFinite(opts.resources.cpus) || opts.resources.cpus <= 0) throw new Error('invalid cpus');
    this.opts = opts;
  }

  async spawn(spec: SpawnSpec): Promise<SandboxProcess> {
    if (!this.opts || !this.carrier) throw new Error('DockerBackend.spawn called before prepare()');
    const args = buildDockerArgs({
      config: this.input.config, prepare: this.opts, spec,
      networkName: this.carrier.internalNetwork, containerName: this.runtimeContainer,
    });
    const child = spawnChild('docker', args, { stdio: ['pipe', 'pipe', 'pipe'] });
    const stdout = new PassThrough();
    const stderr = new PassThrough();
    child.stdout!.pipe(stdout);
    child.stderr!.pipe(stderr);
    const exited = collectBoundedResult(child, stdout, stderr, this.runtimeContainer, this.input.config.defaults.outputMaxBytes, this.opts, spec);
    let closed = false;
    return {
      stdin: child.stdin!,
      stdout,
      stderr,
      exited,
      kill: async (signal) => {
        child.kill(signal ?? 'SIGKILL');
        await runDocker(['rm', '-f', this.runtimeContainer]).catch(() => {});
      },
      close: async () => {
        if (closed) return;
        closed = true;
        child.stdin!.end();
        if (child.exitCode === null) await runDocker(['rm', '-f', this.runtimeContainer]).catch(() => {});
        await exited;
      },
    };
  }

  async run(spec: ExecSpec): Promise<BackendRunResult> {
    const process = await this.spawn({ ...spec, stdin: 'pipe' });
    if (typeof spec.stdin === 'string' || spec.stdin instanceof Uint8Array) process.stdin.write(spec.stdin);
    process.stdin.end();
    try { return await process.exited; }
    finally { await process.close(); }
  }

  async cleanup(): Promise<void> {
    // Memoized first outcome (T3): repeat calls rethrow the SAME
    // ContainmentCleanupError instance (or resolve identically). Never
    // logs-and-swallows a containment failure.
    if (this.cleanupOutcome) {
      if (this.cleanupOutcome.error) throw this.cleanupOutcome.error;
      return;
    }
    if (this.cleaned) return;
    this.cleaned = true;

    const containmentReasons: string[] = [];
    const softReasons: string[] = [];

    // CONTAINMENT: runtime-container removal. A failure here may leave the
    // runtime container alive — the skill's process may still be running
    // outside the teardown boundary.
    try {
      await this.runDockerImpl(['rm', '-f', this.runtimeContainer]);
    } catch (err) {
      // Reason strings are the trusted teardown error's .message only — no
      // credential/grant material is ever interpolated here.
      containmentReasons.push((err as Error).message ?? String(err));
    }

    // SOFT (best-effort): proxy-side network disconnects. The proxy
    // container's lifecycle is owned externally; failing to disconnect it
    // from a network is host hygiene once the runtime container is gone.
    try {
      await this.runDockerImpl(['network', 'disconnect', '-f', this.egressNetwork, this.proxyContainer]);
    } catch (err) {
      softReasons.push((err as Error).message ?? String(err));
    }
    try {
      await this.runDockerImpl(['network', 'disconnect', '-f', this.internalNetwork, this.proxyContainer]);
    } catch (err) {
      softReasons.push((err as Error).message ?? String(err));
    }
    // SOFT (best-effort): network removal races. The runtime container is
    // already destroyed at this point, so a stale network can never carry
    // skill traffic.
    try {
      await this.removeNetworkImpl(this.internalNetwork);
    } catch (err) {
      softReasons.push((err as Error).message ?? String(err));
    }
    try {
      await this.removeNetworkImpl(this.egressNetwork);
    } catch (err) {
      softReasons.push((err as Error).message ?? String(err));
    }

    if (softReasons.length > 0) {
      // Diagnostic-only — never promoted to containment.
      // eslint-disable-next-line no-console
      console.warn('DockerBackend.cleanup: soft network teardown errors', softReasons);
    }

    this.cleanupOutcome = {
      error:
        containmentReasons.length > 0
          ? new ContainmentCleanupError(containmentReasons)
          : undefined,
    };
    if (this.cleanupOutcome.error) throw this.cleanupOutcome.error;
  }
}

// collectBoundedResult enforces the prepared timeout and combined output cap,
// destroys the named runtime container on either limit, and resolves exactly one
// BackendRunResult with full-isolation metadata.
function collectBoundedResult(
  child: ChildProcess,
  stdout: PassThrough,
  stderr: PassThrough,
  containerName: string,
  defaultOutputMaxBytes: number,
  opts: BackendPrepareOptions,
  spec: SpawnSpec,
): Promise<BackendRunResult> {
  const timeoutMs = spec.timeoutMs ?? opts.resources.timeoutMs;
  const outputMaxBytes = spec.outputMaxBytes ?? defaultOutputMaxBytes;
  const outChunks: Buffer[] = [];
  const errChunks: Buffer[] = [];
  let outBytes = 0;
  let errBytes = 0;
  let timedOut = false;
  let outputOverflow = false;
  let settled = false;

  const destroyContainer = () => runDocker(['rm', '-f', containerName]).catch(() => {});

  return new Promise<BackendRunResult>((resolve) => {
    const settle = (exitCode: number) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      const so = Buffer.concat(outChunks).toString('utf8');
      const se = Buffer.concat(errChunks).toString('utf8');
      const stderrFinal = outputOverflow ? `${se}\noutput cap exceeded (outputMaxBytes=${outputMaxBytes})` : se;
      resolve({
        exitCode,
        stdout: so,
        stderr: stderrFinal,
        timedOut,
        meta: { isolationLevel: 'full', backend: 'docker', degraded: false, degradationReasons: [] },
      });
    };

    const onData = (which: 'out' | 'err') => (chunk: Buffer) => {
      if (which === 'out') { outChunks.push(chunk); outBytes += chunk.length; }
      else { errChunks.push(chunk); errBytes += chunk.length; }
      // Enforce the COMBINED stdout+stderr cap (spec §7).
      if (outBytes + errBytes > outputMaxBytes && !outputOverflow) {
        outputOverflow = true;
        child.kill('SIGKILL');
        void destroyContainer();
      }
    };
    stdout.on('data', onData('out'));
    stderr.on('data', onData('err'));

    const timer = setTimeout(() => {
      if (!settled && !outputOverflow) {
        timedOut = true;
        child.kill('SIGKILL');
        void destroyContainer();
      }
    }, timeoutMs);

    child.on('close', (code) => settle(timedOut || outputOverflow ? 137 : code ?? 0));
    child.on('error', () => settle(1));
  });
}
