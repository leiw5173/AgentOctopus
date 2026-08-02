// packages/sandbox/src/vm/vm-backend.ts
import { randomUUID } from 'node:crypto';
import { mkdir, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { PassThrough } from 'node:stream';
import type {
  SandboxBackend, BackendPrepareOptions, ExecSpec, SpawnSpec,
  SandboxProcess, BackendRunResult, ProxyCarrier,
} from '../backend.js';
import { ContainmentCleanupError } from '../backend.js';
import type { SandboxConfig } from '../schema.js';
import { SNAPSHOT_DIGEST_RE } from '../schema.js';
import { stripIpv6Brackets } from '../host-match.js';
import type { VmEnginePort, VmImageBuilderPort, VmInstance, VmStartConfig } from './ports.js';
import type { VmWorkloadSpec } from './types.js';
import { encodeLaunchSpec } from './launch-spec.js';
import { buildGuestEnv } from './env.js';
import { buildBlockImages } from './block-image.js';
import { RunSpecError } from './errors.js';
import { VsockBridge } from './vsock-bridge.js';

const BOOTSTRAP_PATH = '/usr/libexec/octopus-vm-init';
const BOOTSTRAP_BIN_NAME = 'octopus-vm-init';
const READY_TIMEOUT_MS = 10_000;
const LOOPBACK_HOSTS = new Set(['127.0.0.1', '::1', 'localhost']);

export class VmSandboxBackend implements SandboxBackend {
  readonly kind = 'vm' as const;
  readonly isolationLevel = 'full' as const;

  private carrier?: { kind: 'in-process'; listenHost: string; reachableHost: string };
  private opts?: BackendPrepareOptions;
  private rootfsArtifact?: import('./ports.js').VerifiedArtifact;
  private skillBlockImage?: import('./ports.js').VerifiedArtifact;
  private caBlockImage?: import('./ports.js').VerifiedArtifact;
  private vm?: VmInstance;
  private readonly sessionId: string;
  private readonly workDir: string; // backend-owned (mirrors OsSandboxBackend.workDir)
  private vsockPort = 0;          // assigned in prepare() (ephemeral)
  private vsockHostSocket = '';   // per-session AF_VSOCK host socket path
  private vsockBridge?: VsockBridge;
  private cleaned = false;
  private cleanupOutcome?: { error?: ContainmentCleanupError };

  constructor(private readonly input: {
    config: SandboxConfig;
    engine: VmEnginePort;
    imageBuilder: VmImageBuilderPort;
    sessionId?: string;
    workDir?: string; // test-injected; defaults to a per-session tmpdir path
  }) {
    this.sessionId = input.sessionId ?? randomUUID().slice(0, 8);
    this.workDir = input.workDir ?? path.join(tmpdir(), `oct-vm-backend-${this.sessionId}`);
  }

  async probe(): Promise<boolean> {
    const r = await this.input.engine.probe();
    return r.available; // R4 P1-1: probe does NOT check selected rootfs (no profile yet).
  }

  async prepareTopology(): Promise<ProxyCarrier> {
    // The in-process carrier is created here, but the vsock bridge cannot start
    // until the egress proxy's actual loopback port is known. The runner calls
    // prepareTopology(), launches the proxy, then passes proxyAddr to prepare().
    this.carrier = { kind: 'in-process', listenHost: '127.0.0.1', reachableHost: '127.0.0.1' };
    return this.carrier;
  }

  private parseProxyLoopbackAddr(proxyAddr: string): { host: string; port: number } {
    let url: URL;
    try {
      url = new URL(proxyAddr);
    } catch {
      throw new Error(`VmSandboxBackend: proxyAddr is not a valid URL: ${proxyAddr}`);
    }
    if (url.protocol !== 'http:') {
      throw new Error(`VmSandboxBackend: proxyAddr protocol must be http:, got ${url.protocol}`);
    }
    const host = stripIpv6Brackets(url.hostname);
    const port = parseInt(url.port, 10);
    if (!host || Number.isNaN(port) || port <= 0 || port > 65535) {
      throw new Error(`VmSandboxBackend: proxyAddr must be http://<host>:<port>, got ${proxyAddr}`);
    }
    // The contract is the in-process egress proxy loopback. Enforce it: a
    // non-loopback host would bridge the guest's sole egress path to an
    // arbitrary/attacker-controlled address, breaking containment.
    // F6: Node's URL.hostname PRESERVES IPv6 brackets
    // (`new URL('http://[::1]:8').hostname` === `"[::1]"`), so strip them
    // before the loopback set lookup — otherwise the explicitly-allowed
    // `::1` is rejected.
    if (!LOOPBACK_HOSTS.has(host)) {
      throw new Error(`VmSandboxBackend: proxyAddr host must be loopback (127.0.0.1, ::1, localhost), got ${host}`);
    }
    return { host, port };
  }

  async prepare(opts: BackendPrepareOptions): Promise<void> {
    if (!this.carrier) await this.prepareTopology();
    const carrier = this.carrier!;
    if (carrier.kind !== 'in-process') throw new Error('vm backend requires in-process carrier');
    if (opts.guestSkillRoot !== '/skill' || opts.guestCaBundlePath !== '/etc/skill-ca/ca.pem') {
      throw new Error('invalid canonical guest mount paths');
    }
    if (!SNAPSHOT_DIGEST_RE.test(opts.expectedSnapshotDigest)) {
      throw new Error('VmSandboxBackend.prepare: expectedSnapshotDigest must match sha256:<64 lowercase hex>');
    }
    const vm = opts.runtimeProfile.vmRuntime;
    if (!vm || !vm.rootfs) throw new Error('vm branch requires runtimeProfile.vmRuntime.rootfs (no fallback to sandbox.vm.rootfs)');
    // Backend-owned workDir (mirrors OsSandboxBackend.workDir): created 0700 here,
    // holds the per-session block images. NOT a BackendPrepareOptions field.
    await mkdir(this.workDir, { recursive: true, mode: 0o700 });
    // R4 P1-1: rootfs qualification lives HERE (probe couldn't — no profile at probe time).
    this.rootfsArtifact = await this.input.engine.resolveRootfs(vm.rootfs);
    await this.input.engine.assertRootfsQualified(vm.rootfs);
    await this.input.engine.assertExecutablesQualified(vm.rootfs, vm.executables, opts.runtimeProfile.bins);
    // LO-3: the guest bootstrap PID 1 (BOOTSTRAP_PATH, exec'd by the helper at
    // spawn) is NOT a skill-requested bin, so it is NOT in the runtime-profile
    // `executables` map vetted above. Verify it separately with a second call:
    // a synthesized single-entry map {bin: path} + matching [bin] keeps the
    // assertExecutablesQualified set-equality contract (executables keys ===
    // bins) intact AND reuses the full rootfs stat-walk (regular file, not a
    // symlink, executable bit set, not under a mount-override). Fail-closed:
    // a missing/unqualified bootstrap must never let spawn() exec an unvetted
    // guest PID 1.
    await this.input.engine.assertExecutablesQualified(
      vm.rootfs,
      { [BOOTSTRAP_BIN_NAME]: BOOTSTRAP_PATH },
      [BOOTSTRAP_BIN_NAME],
    );
    // Start the per-session vsock bridge AFTER the proxy is running, using the
    // actual loopback port from prepareOpts.proxyAddr. Fail-closed: if the
    // bridge cannot bind its unix socket, the backend must not proceed.
    const { host: proxyHost, port: proxyPort } = this.parseProxyLoopbackAddr(opts.proxyAddr);
    this.vsockBridge = new VsockBridge({ workDir: this.workDir, proxyHost, proxyPort });
    const { vsockPort, vsockHostSocket } = await this.vsockBridge.start();
    this.vsockPort = vsockPort;
    this.vsockHostSocket = vsockHostSocket;
    // R4 P1-2: both block images (skill dir + CA single-file). Backend computes
    // the CA expectedFileDigest inside buildBlockImages BEFORE delegating.
    const { skillBlockImage, caBlockImage } = await buildBlockImages(this.input.imageBuilder, {
      snapshotRoot: opts.snapshotRoot,
      expectedSnapshotDigest: opts.expectedSnapshotDigest,
      caBundlePath: opts.caBundlePath,
      outDir: this.workDir,
    });
    this.skillBlockImage = skillBlockImage;
    this.caBlockImage = caBlockImage;
    this.opts = opts;
  }

  async spawn(spec: SpawnSpec): Promise<SandboxProcess> {
    if (!this.opts || !this.carrier) throw new Error('VmSandboxBackend.spawn called before prepare()');
    if (!this.rootfsArtifact || !this.skillBlockImage || !this.caBlockImage) throw new Error('prepare() did not resolve artifacts');
    // R8 P1-3 / R9 local: empty-command check BEFORE reading command[0].
    if (spec.command.length === 0) throw new RunSpecError('vm: empty command');
    const opts = this.opts;
    const guestProxyAddr = `http://127.0.0.1:${this.vsockPort}`;
    // Trusted finalEnv: untrusted spec.env FIRST, trusted overrides win on collision.
    const env = buildGuestEnv(spec.env, guestProxyAddr, opts.guestCaBundlePath);
    const allowedExecutables = opts.runtimeProfile.vmRuntime!.executables; // trusted, gate-verified
    const workloadSpec: VmWorkloadSpec = {
      executable: spec.command[0],        // R8 P1-3: command[0] → execve pathname
      argv: [...spec.command],             // R8 P1-3: command[] → execve argv (argv[0] = program name)
      cwd: spec.cwd ?? opts.guestSkillRoot,
      env,
      allowedExecutables,
    };
    // NUL rejection + size caps fire inside encodeLaunchSpec (Task 3).
    const { blob: launchSpecBlob } = encodeLaunchSpec(workloadSpec);
    // R6 P1-1/R7 P1-3: bootstrapArgv carries ONLY the launch-spec blob.
    // libkrun's krun_set_exec uses bootstrapPath (exec_path) as the guest's
    // argv[0] and appends bootstrapArgv AFTER it — so the array must NOT
    // repeat bootstrapPath, or the guest sees argv=[path, path, blob] and
    // vm-init reads the path (not the blob) at argv[1] → "decode/validate
    // failed". With argv=[blob] the guest gets argv=[path, blob]: argv[1]=blob.
    const bootstrapArgv = [launchSpecBlob];
    const vm = await this.input.engine.start({
      rootfsArtifact: this.rootfsArtifact,
      skillBlockImage: this.skillBlockImage,
      caBlockImage: this.caBlockImage,
      bootstrapPath: BOOTSTRAP_PATH,
      bootstrapArgv,
      vsockPort: this.vsockPort,
      vsockHostSocket: this.vsockHostSocket,
      memMib: opts.runtimeProfile.vmRuntime!.memMib,
      cpus: opts.runtimeProfile.vmRuntime!.cpus,
      readyTimeoutMs: READY_TIMEOUT_MS,
      libkrunAbi: 'v1.19.4',
      trustedEnv: [
        `OCTOPUS_VSOCK_PORT=${this.vsockPort}`,
        `OCTOPUS_VSOCK_HOST_SOCKET=${this.vsockHostSocket}`,
      ],
    });
    this.vm = vm;
    return collectBoundedVmResult(
      vm,
      spec.timeoutMs ?? opts.resources.timeoutMs,
      spec.outputMaxBytes ?? this.input.config.defaults.outputMaxBytes,
    );
  }

  async run(spec: ExecSpec): Promise<BackendRunResult> {
    const p = await this.spawn({ ...spec, stdin: 'pipe' });
    if (typeof spec.stdin === 'string' || spec.stdin instanceof Uint8Array) p.stdin.write(spec.stdin);
    p.stdin.end();
    try { return await p.exited; }
    finally { await p.close(); }
  }

  async cleanup(): Promise<void> {
    // Memoized first outcome (T3): repeat calls rethrow the SAME error / resolve identically.
    if (this.cleanupOutcome) {
      if (this.cleanupOutcome.error) throw this.cleanupOutcome.error;
      return;
    }
    if (this.cleaned) return;
    this.cleaned = true;
    const containmentReasons: string[] = [];
    const softReasons: string[] = [];
    // CONTAINMENT: VmInstance.kill() failure may leave the helper/VM running skill code.
    try { await this.vm?.kill(); }
    catch (err) { containmentReasons.push(`vm helper kill failed: ${(err as Error).message ?? String(err)}`); }
    // SOFT (best-effort, never promoted): vsock bridge close, block-image temp removal.
    // No inner .catch(() => {}) — let failures surface into softReasons diagnostics.
    try { await this.vsockBridge?.stop(); }
    catch (err) { softReasons.push(`vsock bridge stop failed: ${(err as Error).message ?? String(err)}`); }
    try { await this.vm?.close(); }
    catch (err) { softReasons.push((err as Error).message ?? String(err)); }
    // ME-2: remove the backend-owned workDir (holds the sealed skill.img + ca.img
    // block images). SOFT — best-effort host-fs hygiene, never a containment
    // failure (the VM is already killed; only an unkillable helper is). force:
    // true so a missing dir (e.g. never created, or already reaped) is a no-op.
    try { await rm(this.workDir, { recursive: true, force: true }); }
    catch (err) { softReasons.push(`workDir removal failed: ${(err as Error).message ?? String(err)}`); }
    // SOFT: release the engine's pinned rootfs fd + engine-private verified TCB
    // copies (probe() materialized them; they live for the backend's lifetime).
    try { await this.input.engine.close(); }
    catch (err) { softReasons.push(`engine close failed: ${(err as Error).message ?? String(err)}`); }
    if (softReasons.length) console.warn('VmSandboxBackend.cleanup: soft teardown errors', softReasons);
    this.cleanupOutcome = {
      error: containmentReasons.length ? new ContainmentCleanupError(containmentReasons) : undefined,
    };
    if (this.cleanupOutcome.error) throw this.cleanupOutcome.error;
  }
}

export function collectBoundedVmResult(
  vm: VmInstance,
  timeoutMs: number,
  outputMaxBytes: number,
): SandboxProcess {
  const stdout = new PassThrough();
  const stderr = new PassThrough();
  vm.stdout.pipe(stdout);
  vm.stderr.pipe(stderr);
  const outChunks: Buffer[] = []; const errChunks: Buffer[] = [];
  let outBytes = 0; let errBytes = 0; let timedOut = false; let overflow = false; let settled = false;
  // F5: the output cap must be a real memory bound. Previously the chunk was
  // pushed BEFORE the cap check and there was no early return after overflow,
  // so a flooding process could keep pushing chunks (and Buffer.concat would
  // realize all of them) until the kill actually landed — memory use ran far
  // past outputMaxBytes. Now: once overflow is set we drop further chunks, and
  // the chunk that crosses the cap is trimmed so the combined buffer never
  // exceeds outputMaxBytes.
  const onData = (which: 'out' | 'err') => (c: Buffer) => {
    if (overflow) return; // already over cap: stop buffering, the kill is in flight
    if (which === 'out') {
      const before = outBytes + errBytes;
      if (before + c.length > outputMaxBytes) {
        const remaining = outputMaxBytes - before;
        if (remaining > 0) { outChunks.push(c.subarray(0, remaining)); outBytes += remaining; }
        overflow = true; vm.kill().catch(() => {});
        return;
      }
      outChunks.push(c); outBytes += c.length;
    } else {
      const before = outBytes + errBytes;
      if (before + c.length > outputMaxBytes) {
        const remaining = outputMaxBytes - before;
        if (remaining > 0) { errChunks.push(c.subarray(0, remaining)); errBytes += remaining; }
        overflow = true; vm.kill().catch(() => {});
        return;
      }
      errChunks.push(c); errBytes += c.length;
    }
  };
  stdout.on('data', onData('out')); stderr.on('data', onData('err'));
  const timer = setTimeout(() => { if (!settled && !overflow) { timedOut = true; vm.kill().catch(() => {}); } }, timeoutMs);
  const exited = vm.exited.then((r) => {
    if (settled) return Promise.resolve(undefined as any);
    settled = true; clearTimeout(timer);
    const so = Buffer.concat(outChunks).toString('utf8');
    const se = Buffer.concat(errChunks).toString('utf8');
    return {
      exitCode: timedOut || overflow ? 137 : r.exitCode,
      stdout: so,
      stderr: overflow ? `${se}\noutput cap exceeded (outputMaxBytes=${outputMaxBytes})` : se,
      timedOut,
      meta: { isolationLevel: 'full', backend: 'vm', degraded: false, degradationReasons: [] } as const,
    };
  });
  return {
    stdin: vm.stdin, stdout, stderr, exited,
    kill: (sig) => vm.kill(),
    close: async () => { stdout.end(); stderr.end(); await vm.close(); },
  };
}
