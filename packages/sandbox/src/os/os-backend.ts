/**
 * Plan 4, Task 5 — `OsSandboxBackend`: Linux namespace + cgroup v2 backend.
 *
 * Wires the Task 1–4 primitives into the canonical `SandboxBackend`
 * interface:
 *   - Task 1 `probeOsCaps` / `fullLevel`          (src/os/probe.ts)
 *   - Task 2 `verifyRuntimeArtifact`/`assembleRootfs` (src/os/rootfs.ts)
 *   - Task 3 `verifyHelperArtifact`/`buildOsRunCommand` (src/os/helper-build.ts, src/os/run-spec.ts)
 *   - Task 3 `createLimitedCgroup`                (src/os/cgroup.ts)
 *   - Task 4 `setupNetns`/`authorizeProxyEndpoint`(src/os/netns.ts)
 *
 * The proxy lifecycle is owned EXTERNALLY by the canonical SandboxRunner +
 * DefaultProxyLauncher: prepareTopology() returns the carrier, the runner
 * launches the proxy and passes the resulting `proxyAddr`/`caBundlePath`
 * into prepare(). This backend never launches, stores, or closes a
 * `ProxyHandle`. prepare() only validates the supplied coordinates against
 * the carrier (host/port match) and authorizes the nft allow rule.
 *
 * Lifecycle: new → probe() → prepareTopology() → prepare() → spawn()/run() →
 * cleanup(). Cleanup is idempotent. Teardown order is process → backend
 * runtime/topology (cgroup, rootfs, netns) → externally owned proxy handle.
 * This is NOT a pure reverse-dependency order for the netns: the proxy binds
 * host-side over the carrier, but teardown is safe because the skill's nft
 * rules and netns are already gone before the runner closes the external
 * proxy handle, so no skill traffic can reach the proxy, and the launcher's
 * child kill is idempotent (SIGTERM then bounded wait).
 *
 * Artifact sourcing (the constructor carries no config): `resolveOsArtifacts()`
 * reads `OCTOPUS_SANDBOX_OS_*` / `OCTOPUS_SANDBOX_PROXY_*` env vars with
 * well-known-path fallbacks under the package root, and verifies every
 * artifact (runtime pair, helper pair, proxy bundle pair) before any value
 * is used. A missing/unverifiable artifact is an AVAILABILITY signal, never
 * a rejection — `probe()` returns false on any artifact error.
 *
 * DI seam: all side-effecting collaborators are injectable via the optional
 * `deps` field on the constructor options. Production callers never set it;
 * unit tests on macOS inject fakes so ORDER and fail-closed behavior can be
 * exercised without a kernel. The seam is never consulted for behavior.
 *
 * Leaf-package rule: Node stdlib + zod (via helper-build) only. Never any
 * `@agentoctopus/*` import.
 */

import { spawn as spawnChild, type ChildProcess } from 'node:child_process';
import { createHash } from 'node:crypto';
import { createReadStream } from 'node:fs';
import { mkdir, mkdtemp, readFile, rm, stat } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { PassThrough } from 'node:stream';
import { fileURLToPath } from 'node:url';
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
import { SNAPSHOT_DIGEST_RE } from '../schema.js';
import type { IsolationLevel } from '../types.js';
import {
  probeOsCaps,
  fullLevel,
  type OsCaps,
} from './probe.js';
import {
  assembleRootfs,
  verifyRuntimeArtifact,
  RootfsError,
  type RootfsLayout,
} from './rootfs.js';
import { verifyHelperArtifact } from './helper-build.js';
import { buildOsRunCommand, cleanupLaunchSpec, type OsRunCommand } from './run-spec.js';
import { createLimitedCgroup, type CgroupHandle } from './cgroup.js';
import { setupNetns, authorizeProxyEndpoint, type NetnsHandle } from './netns.js';

// ---------------------------------------------------------------------------
// Artifact resolution
// ---------------------------------------------------------------------------

/**
 * Locations of every artifact the backend needs, fully verified.
 *
 * Paths default to `<pkg>/runtime/...` and `<pkg>/build/...` (where `<pkg>`
 * is `packages/sandbox`). Environment variables override each path so the
 * backend can be exercised against fixtures in tests / staging.
 */
export interface ResolvedOsArtifacts {
  runtimeArtifactPath: string;
  runtimeManifestPath: string;
  helperManifestPath: string;
  helperBinaryPath: string;
  proxyBundlePath: string;
  proxyBundleManifestPath: string;
}

/** Resolve the package root from this module's location (works in src and dist). */
function packageRoot(): string {
  // src/os/os-backend.ts → packages/sandbox; dist/os/os-backend.js → packages/sandbox.
  return fileURLToPath(new URL('../..', import.meta.url));
}

function envOr(name: string, fallback: string): string {
  const v = process.env[name];
  return v && v.length > 0 ? v : fallback;
}

async function sha256File(p: string): Promise<string> {
  return await new Promise((resolvePromise, rejectPromise) => {
    const h = createHash('sha256');
    const s = createReadStream(p);
    s.on('data', (c: Buffer) => h.update(c));
    s.on('end', () => resolvePromise(h.digest('hex')));
    s.on('error', rejectPromise);
  });
}

/**
 * Verify the proxy bundle against its digest manifest. The manifest is the
 * same shape as the helper manifest (`HelperArtifactManifestSchema`):
 * `{ schemaVersion: 1, helperSha256, size, mode }`. The bundle is executed
 * under `node` (not as a native binary) so the `mode` field records the
 * expected permission bits (typically 0644 — the bundle needs to be
 * readable, not executable). We enforce the digest + size and forbid
 * group/world-writability; the manifest's `helperSha256` field is the
 * bundle's SHA-256 (bare 64 lowercase hex, no `sha256:` prefix).
 *
 * Exported so the portable manifest-shape test exercises the REAL verifier.
 */
export async function verifyProxyBundle(
  bundlePath: string,
  manifestPath: string,
): Promise<void> {
  const raw = await readFile(manifestPath, 'utf8').catch((err) => {
    throw new RootfsError(`cannot read proxy bundle manifest: ${(err as Error).message}`);
  });
  let parsed: { schemaVersion?: unknown; helperSha256?: unknown; size?: unknown; mode?: unknown };
  try {
    parsed = JSON.parse(raw);
  } catch (err) {
    throw new RootfsError(`proxy bundle manifest is not valid JSON: ${(err as Error).message}`);
  }
  if (parsed.schemaVersion !== 1) {
    throw new RootfsError('proxy bundle manifest schemaVersion must be 1');
  }
  if (typeof parsed.helperSha256 !== 'string' || !/^[0-9a-f]{64}$/.test(parsed.helperSha256)) {
    throw new RootfsError('proxy bundle manifest helperSha256 must be 64 lowercase hex');
  }
  if (typeof parsed.size !== 'number' || !Number.isInteger(parsed.size) || parsed.size <= 0) {
    throw new RootfsError('proxy bundle manifest size must be a positive integer');
  }
  if (typeof parsed.mode !== 'number' || !Number.isInteger(parsed.mode) || parsed.mode < 0) {
    throw new RootfsError('proxy bundle manifest mode must be a non-negative integer');
  }
  const st = await stat(bundlePath).catch((err) => {
    throw new RootfsError(`cannot stat proxy bundle: ${(err as Error).message}`);
  });
  if (!st.isFile()) throw new RootfsError(`proxy bundle at ${bundlePath} is not a regular file`);
  if (st.size !== parsed.size) {
    throw new RootfsError(`proxy bundle size mismatch: manifest declares ${parsed.size}, file is ${st.size}`);
  }
  const digest = await sha256File(bundlePath);
  if (digest !== parsed.helperSha256) {
    throw new RootfsError(
      `proxy bundle digest mismatch: manifest declares ${parsed.helperSha256}, computed ${digest}`,
    );
  }
  const actualMode = st.mode & 0o7777;
  if ((actualMode & 0o022) !== 0) {
    throw new RootfsError(
      `proxy bundle at ${bundlePath} is group/world-writable (mode ${actualMode.toString(8)}) — refusing to launch`,
    );
  }
}

/**
 * Resolve every artifact path (env var override → package-root fallback),
 * then verify each artifact against its manifest. Throws `RootfsError`
 * (fail closed) if any artifact is missing or fails verification.
 */
async function resolveOsArtifactsReal(): Promise<ResolvedOsArtifacts> {
  const pkg = packageRoot();
  const runtimeArtifactPath = envOr(
    'OCTOPUS_SANDBOX_OS_RUNTIME_ARTIFACT',
    path.join(pkg, 'runtime', 'linux-node22.rootfs.tar.zst'),
  );
  const runtimeManifestPath = envOr(
    'OCTOPUS_SANDBOX_OS_RUNTIME_MANIFEST',
    path.join(pkg, 'runtime', 'linux-node22.manifest.json'),
  );
  const helperManifestPath = envOr(
    'OCTOPUS_SANDBOX_OS_HELPER_MANIFEST',
    path.join(pkg, 'runtime', 'os-helper.manifest.json'),
  );
  const helperBinaryPath = envOr(
    'OCTOPUS_SANDBOX_OS_HELPER_BINARY',
    path.join(pkg, 'runtime', 'os-helper'),
  );
  const proxyBundlePath = envOr(
    'OCTOPUS_SANDBOX_PROXY_BUNDLE',
    path.join(pkg, 'build', 'egress-proxy-server.mjs'),
  );
  const proxyBundleManifestPath = envOr(
    'OCTOPUS_SANDBOX_PROXY_MANIFEST',
    path.join(pkg, 'build', 'egress-proxy-server.mjs.manifest.json'),
  );

  // Verify everything before any value is used.
  await verifyRuntimeArtifact({ artifactPath: runtimeArtifactPath, manifestPath: runtimeManifestPath });
  await verifyHelperArtifact({ helperPath: helperBinaryPath, manifestPath: helperManifestPath });
  await verifyProxyBundle(proxyBundlePath, proxyBundleManifestPath);

  return {
    runtimeArtifactPath,
    runtimeManifestPath,
    helperManifestPath,
    helperBinaryPath,
    proxyBundlePath,
    proxyBundleManifestPath,
  };
}

// ---------------------------------------------------------------------------
// DI seam — injectable collaborators (never consulted for behavior)
// ---------------------------------------------------------------------------

export interface OsBackendDeps {
  probeOsCaps?: typeof probeOsCaps;
  resolveOsArtifacts?: () => Promise<ResolvedOsArtifacts>;
  setupNetns?: typeof setupNetns;
  authorizeProxyEndpoint?: typeof authorizeProxyEndpoint;
  createLimitedCgroup?: typeof createLimitedCgroup;
  assembleRootfs?: typeof assembleRootfs;
  buildOsRunCommand?: typeof buildOsRunCommand;
  spawnHelper?: (cmd: OsRunCommand) => ChildProcess;
  /**
   * Injectable cgroup-root stat (fail-closed validation). Production callers
   * never set this; unit tests on macOS inject a stub so the directory check
   * can be exercised without a real /sys/fs/cgroup. Never consulted for
   * behavior — only for the existence/directory I/O gate.
   */
  stat?: (p: string) => Promise<{ isDirectory: () => boolean }>;
}

// ---------------------------------------------------------------------------
// Backend
// ---------------------------------------------------------------------------

export interface OsSandboxBackendOptions {
  sessionId: string;
  /** Working directory for the backend's own state (rootfs staging, launch specs). */
  workDir?: string;
  /**
   * Delegated cgroup v2 mount root. Defaults to `/sys/fs/cgroup`; the
   * `OCTOPUS_TEST_CGROUP_PARENT` env var provides a fallback for tests on
   * hosts that don't own the cgroup root. The root is validated fail-closed
   * (must exist and be a directory) before any cgroup is created.
   */
  cgroupRoot?: string;
  /** Injectable collaborators. Production callers omit this. */
  deps?: OsBackendDeps;
}

interface ActiveChild {
  child: ChildProcess;
  launchSpecPath: string;
}

export class OsSandboxBackend implements SandboxBackend {
  readonly kind = 'os' as const;

  private readonly sessionId: string;
  private readonly workDir: string;
  private readonly deps: OsBackendDeps;
  private readonly cgroupRoot: string;

  private probed = false;
  private caps: OsCaps | undefined;
  private artifacts: ResolvedOsArtifacts | undefined;
  private netns: NetnsHandle | undefined;
  private carrier: Extract<ProxyCarrier, { kind: 'linux-static' }> | undefined;
  private proxyCgroupPath: string | undefined;
  private opts: BackendPrepareOptions | undefined;
  private layout: RootfsLayout | undefined;
  private cgroup: CgroupHandle | undefined;
  private activeChild: ActiveChild | undefined;
  private specDir: string | undefined;
  private cleaned = false;
  /**
   * Memoized FIRST cleanup outcome (T3 contract). Once set, repeat cleanup()
   * calls rethrow the same ContainmentCleanupError or resolve identically.
   * Stored AFTER cleanupPartial completes so concurrent callers serialize on
   * `cleaned` + this memo.
   */
  private cleanupOutcome: { error?: ContainmentCleanupError } | undefined;
  /**
   * Non-benign teardown errors recorded by the most recent netns cleanup
   * (see netns.ts cleanupErrors). Captured in cleanupPartial step 5 after the
   * netns handle is released. Empty when teardown was clean. Surfaced via the
   * concrete-class `netnsCleanupErrors` getter so the privileged lane can
   * diagnose a leaked veth/netns.
   */
  private lastNetnsCleanupErrors: ReadonlyArray<{ argv: string[]; error: string }> = [];

  constructor(opts: OsSandboxBackendOptions) {
    if (!opts.sessionId || typeof opts.sessionId !== 'string') {
      throw new Error('OsSandboxBackend: sessionId is required');
    }
    this.sessionId = opts.sessionId;
    this.workDir = opts.workDir ?? path.join(os.tmpdir(), `oct-os-backend-${this.sessionId}`);
    this.deps = opts.deps ?? {};
    // Precedence: explicit option > OCTOPUS_TEST_CGROUP_PARENT env > /sys/fs/cgroup.
    const envRoot = process.env.OCTOPUS_TEST_CGROUP_PARENT;
    this.cgroupRoot = opts.cgroupRoot ?? (envRoot && envRoot.length > 0 ? envRoot : '/sys/fs/cgroup');
  }

  /**
   * Absolute path of the skill cgroup created by prepare(), as reported by
   * the CgroupHandle. Undefined before prepare() and after cleanup().
   *
   * This is a CONCRETE-CLASS-ONLY getter — it is intentionally NOT on the
   * SandboxBackend interface. Callers that hold only the interface type
   * cannot see it; the privileged Linux lane (Task 6) downcasts or uses the
   * concrete OsSandboxBackend type to access it.
   */
  get skillCgroupPath(): string | undefined {
    return this.cgroup?.path;
  }

  /**
   * Non-benign errors recorded by the most recent netns teardown (empty when
   * clean). CONCRETE-CLASS-ONLY getter (not on the SandboxBackend interface),
   * mirroring skillCgroupPath — the privileged lane downcasts to read it.
   */
  get netnsCleanupErrors(): ReadonlyArray<{ argv: string[]; error: string }> {
    return this.lastNetnsCleanupErrors;
  }

  get isolationLevel(): IsolationLevel {
    if (!this.probed || !this.caps) return 'restricted';
    return fullLevel(this.caps);
  }

  // -------------------------------------------------------------------------
  // probe()
  // -------------------------------------------------------------------------

  async probe(): Promise<boolean> {
    // Platform gate FIRST — on non-Linux we never touch the artifacts (they
    // are built only on Linux+Docker and absent elsewhere). When tests inject
    // a probeOsCaps or resolveOsArtifacts override, that override drives the
    // entire probe so the lifecycle can be exercised on macOS.
    const hasOverride = this.deps.probeOsCaps !== undefined || this.deps.resolveOsArtifacts !== undefined;
    if (process.platform !== 'linux' && !hasOverride) {
      this.probed = true;
      this.caps = {
        platform: process.platform === 'darwin' ? 'darwin' : 'other',
        userMountPidIpcUtsNs: false,
        namedNetns: false,
        nftRuleCreate: false,
        cgroupV2Writable: false,
        runtimeArtifact: false,
        helperArtifact: false,
        sandboxExec: false,
        probeErrors: ['platform is not linux'],
      };
      return false;
    }

    // Artifact availability check — never a rejection. A missing artifact
    // means the OS backend is simply unavailable here, not an error.
    const resolver = this.deps.resolveOsArtifacts ?? resolveOsArtifactsReal;
    let artifacts: ResolvedOsArtifacts;
    try {
      artifacts = await resolver();
    } catch {
      this.probed = true;
      this.caps = {
        platform: 'linux',
        userMountPidIpcUtsNs: false,
        namedNetns: false,
        nftRuleCreate: false,
        cgroupV2Writable: false,
        runtimeArtifact: false,
        helperArtifact: false,
        sandboxExec: false,
        probeErrors: ['artifact resolution failed'],
      };
      return false;
    }
    this.artifacts = artifacts;

    const prober = this.deps.probeOsCaps ?? probeOsCaps;
    const caps = await prober({
      runtimeManifestPath: artifacts.runtimeManifestPath,
      helperManifestPath: artifacts.helperManifestPath,
      helperBinaryPath: artifacts.helperBinaryPath,
    });
    this.probed = true;
    this.caps = caps;
    return fullLevel(caps) === 'full';
  }

  // -------------------------------------------------------------------------
  // prepareTopology()
  // -------------------------------------------------------------------------

  async prepareTopology(): Promise<ProxyCarrier> {
    if (this.carrier) return this.carrier;
    if (!this.probed || !this.caps || fullLevel(this.caps) !== 'full') {
      throw new Error('OsSandboxBackend.prepareTopology: probe() must succeed with full isolation first');
    }
    if (!this.artifacts) {
      throw new Error('OsSandboxBackend.prepareTopology: artifacts were not resolved');
    }

    // Advisory proxy cgroup path (I7): the per-session egress proxy is NOT
    // confined by the skill's memory/cpu/pids limits, so the proxy runs outside
    // the skill cgroup. This name is surfaced on the carrier for the
    // orchestrator/launcher; this backend does NOT create, own, or destroy it,
    // and no test asserts its existence. The skill cgroup (created later in
    // prepare()) is the only cgroup this backend owns. The path is joined under
    // the delegated cgroupRoot for consistency with the skill cgroup.
    this.proxyCgroupPath = path.join(this.cgroupRoot, `oct-proxy-${this.sessionId}`);

    // Set up the named netns + veth pair + base nft table, and allocate
    // the proxy listen port up front (bind proxyIp:0, read ephemeral port,
    // close — the launcher rebinds exactly this port). Keeping the
    // allocate→carrier-rebind gap minimal: the port is handed to the
    // launcher immediately via the returned carrier.
    const setup = this.deps.setupNetns ?? setupNetns;
    this.netns = await setup({ sessionId: this.sessionId });

    this.carrier = {
      kind: 'linux-static',
      binaryPath: this.artifacts.proxyBundlePath,
      skillNamespace: { name: this.netns.name, path: this.netns.path },
      listenHost: this.netns.proxyIp,
      reachableHost: this.netns.proxyIp,
      cgroupPath: this.proxyCgroupPath,
      listenPort: this.netns.proxyPort,
    };
    return this.carrier;
  }

  // -------------------------------------------------------------------------
  // prepare()
  // -------------------------------------------------------------------------

  async prepare(opts: BackendPrepareOptions): Promise<void> {
    // Step 1: validate options FIRST (pure input check, no side effects).
    validatePrepareOptions(opts);

    // Step 2: probe must have run and reported full.
    if (!this.probed || !this.caps || fullLevel(this.caps) !== 'full') {
      throw new Error('OsSandboxBackend.prepare: probe() must succeed with full isolation first');
    }
    if (!this.artifacts) throw new Error('OsSandboxBackend.prepare: artifacts were not resolved');

    // Step 3: topology must have run. The proxy itself is launched and owned
    // EXTERNALLY by the canonical SandboxRunner + DefaultProxyLauncher between
    // prepareTopology() and prepare(); this backend consumes only the supplied
    // `proxyAddr`/`caBundlePath` and must never launch or close a proxy.
    if (!this.carrier || !this.netns) {
      throw new Error('OsSandboxBackend.prepare: prepareTopology() must run before prepare()');
    }

    // Step 4: parse opts.proxyAddr; require host === carrier.reachableHost
    // and port === carrier.listenPort; then install the nft allow rule for
    // exactly that port. A mismatch is fatal and rejects BEFORE
    // authorizeProxyEndpoint installs any nft rule — the orchestrator/launcher
    // is trusted to supply a ready proxy (readiness is proven externally by
    // DefaultProxyLauncher.waitForReady and the privileged lane), so this is a
    // coordinate check, not a liveness probe. No reachability attempt is made
    // here.
    const { host: proxyHost, port: proxyPort } = parseProxyAddr(opts.proxyAddr);
    if (proxyHost !== this.carrier.reachableHost) {
      throw new Error(
        `proxyAddr host mismatch: opts.proxyAddr host '${proxyHost}' does not equal carrier.reachableHost '${this.carrier.reachableHost}'`,
      );
    }
    if (proxyPort !== this.carrier.listenPort) {
      throw new Error(
        `proxyAddr port mismatch: opts.proxyAddr port ${proxyPort} does not equal carrier.listenPort ${this.carrier.listenPort}`,
      );
    }
    const authorize = this.deps.authorizeProxyEndpoint ?? authorizeProxyEndpoint;
    await authorize(this.netns, { proxyListenPort: this.carrier.listenPort });

    try {
      // Step 5: assemble + verify the runtime root. assembleRootfs mkdtemps a
      // rootfs- dir INSIDE workDir, so workDir must exist first — it is only
      // assigned in the constructor and otherwise created later (launch-spec
      // mkdir), so mkdtemp would die ENOENT on the missing parent.
      await mkdir(this.workDir, { recursive: true, mode: 0o700 });
      const assemble = this.deps.assembleRootfs ?? assembleRootfs;
      this.layout = await assemble({
        snapshotRoot: opts.snapshotRoot,
        caBundlePath: opts.caBundlePath,
        workDir: this.workDir,
        runtimeArtifactPath: this.artifacts.runtimeArtifactPath,
        runtimeManifestPath: this.artifacts.runtimeManifestPath,
      });

      // Step 6: create + read back the cgroup limits. Do NOT spawn until
      // this succeeds.
      // Fail-closed root validation: the delegated cgroup root must exist and
      // be a directory before we attempt to create a cgroup under it. If the
      // root is absent or not a directory, throw — never proceed to create a
      // cgroup that would land in the wrong place or fail mid-creation.
      const statFn = this.deps.stat ?? stat;
      let rootSt: { isDirectory: () => boolean };
      try {
        rootSt = await statFn(this.cgroupRoot);
      } catch (err) {
        throw new Error(
          `OsSandboxBackend.prepare: cgroup root '${this.cgroupRoot}' is not accessible: ${(err as Error).message}`,
        );
      }
      if (!rootSt.isDirectory()) {
        throw new Error(
          `OsSandboxBackend.prepare: cgroup root '${this.cgroupRoot}' is not a directory`,
        );
      }

      const cpuMax = cpuMaxFromCpus(opts.resources.cpus);
      const pidsMax = 64;
      const create = this.deps.createLimitedCgroup ?? createLimitedCgroup;
      this.cgroup = await create({
        sessionId: this.sessionId,
        memoryBytes: opts.resources.memoryBytes,
        pidsMax,
        cpuMax,
        cgroupRoot: this.cgroupRoot,
      });

      // Per-spec launch-spec dir under workDir (carry-forward from Task 3).
      await mkdir(this.workDir, { recursive: true, mode: 0o700 });
      this.specDir = await mkdtemp(path.join(this.workDir, 'launch-spec-'));

      this.opts = opts;
    } catch (err) {
      // Clean partial state and rethrow. NEVER convert a setup failure into
      // a restricted run — prepare() throws and the selector fails closed.
      // The partial-cleanup reasons are LOCAL: this call is NOT the memoized
      // cleanup() outcome (a subsequent cleanup() runs its own pass).
      const partialReasons: string[] = [];
      await this.cleanupPartial(partialReasons);
      throw err;
    }
  }

  // -------------------------------------------------------------------------
  // spawn()
  // -------------------------------------------------------------------------

  async spawn(spec: SpawnSpec): Promise<SandboxProcess> {
    if (!this.opts || !this.layout || !this.cgroup || !this.netns || !this.carrier || !this.artifacts) {
      throw new Error('OsSandboxBackend.spawn called before prepare()');
    }
    const opts = this.opts;
    const layout = this.layout;
    const cgroup = this.cgroup;
    const netns = this.netns;
    const artifacts = this.artifacts;
    const specDir = this.specDir!;

    // Build + verify the helper launch spec.
    const build = this.deps.buildOsRunCommand ?? buildOsRunCommand;
    const cmd = await build({
      helperPath: artifacts.helperBinaryPath,
      helperManifestPath: artifacts.helperManifestPath,
      layout,
      netns,
      spec,
      proxyAddr: opts.proxyAddr,
      specDir,
    });

    // Spawn the helper with empty host environment except trusted control
    // variables and stdio pipes.
    const defaultSpawn = (c: OsRunCommand): ChildProcess =>
      spawnChild(c.file, c.args, {
        stdio: ['pipe', 'pipe', 'pipe'],
        env: c.env,
      });
    const doSpawn = this.deps.spawnHelper ?? defaultSpawn;
    const child = doSpawn(cmd);
    const pid = child.pid;
    if (typeof pid !== 'number' || pid <= 0) {
      throw new Error('OsSandboxBackend.spawn: helper child has no pid');
    }

    // Capture the helper's early stderr NOW, before attach. If the helper dies
    // before it can self-stop (a phase-1/phase-2 die() — netns, mount, chroot,
    // spec parse), attach() then fails with ESRCH ("no such process"), which on
    // its own is silent about WHY. The helper always writes its diagnostic to
    // fd 2 before _exit(127), so buffering stderr from the moment of spawn lets
    // the attach-failure error carry the helper's own reason. Bounded to avoid
    // unbounded memory from a runaway pre-exec child.
    let earlyStderr = '';
    const onEarlyData = (chunk: Buffer): void => {
      if (earlyStderr.length < 8192) earlyStderr += chunk.toString('utf8');
    };
    // Real ChildProcess.stderr is an EventEmitter; test doubles may be a bare
    // stream without listener methods. Attach defensively so mocks still work.
    const stderrEmitter = child.stderr as unknown as { on?: (ev: string, fn: (c: Buffer) => void) => void } | null | undefined;
    const canListen = typeof stderrEmitter?.on === 'function';
    if (canListen) child.stderr!.on('data', onEarlyData);

    // Attach the actual child PID through CgroupHandle.attach(), verify
    // membership, then continue it (SIGCONT).
    try {
      await cgroup.attach(pid);
    } catch (err) {
      // Attach failure → never SIGCONT. Kill the stopped child best-effort.
      // Give the dying helper a tick to flush its fd-2 diagnostic, then surface
      // it — an ESRCH means the helper already exited, and its stderr says why.
      try { child.kill('SIGKILL'); } catch { /* best-effort */ }
      await new Promise((resolve) => setTimeout(resolve, 30));
      await cleanupLaunchSpec(cmd.launchSpecPath).catch(() => {});
      const detail = earlyStderr.trim();
      if (detail.length > 0 && err instanceof Error) {
        throw new Error(`${err.message} — helper stderr: ${detail.split('\n').slice(0, 4).join(' | ')}`, { cause: err });
      }
      throw err;
    }
    // SIGCONT the helper to run its full setup + fork + execve inside the
    // session cgroup. The helper was started with --stop-before-exec and the
    // PARENT raised SIGSTOP before phase 1; the cgroup attach is the security
    // gate, so the SIGCONT only fires AFTER membership is verified. The
    // untrusted child (PID-1 in the new ns) inherits the cgroup at fork().
    try {
      child.kill('SIGCONT');
    } catch (err) {
      await cgroup.kill().catch(() => {});
      await cgroup.waitEmpty(2000).catch(() => {});
      await cleanupLaunchSpec(cmd.launchSpecPath).catch(() => {});
      throw err;
    }

    const stdout = new PassThrough();
    const stderr = new PassThrough();
    // Stop the early-stderr buffer from also consuming once we pipe; any bytes
    // captured pre-SIGCONT are the helper's trusted setup diagnostics, not skill
    // output, so they stay out of the skill's stderr stream.
    if (canListen) (child.stderr as unknown as { off?: (ev: string, fn: (c: Buffer) => void) => void })?.off?.('data', onEarlyData);
    child.stdout?.pipe(stdout);
    child.stderr?.pipe(stderr);

    this.activeChild = { child, launchSpecPath: cmd.launchSpecPath };

    const cgroupRef = cgroup;
    const launchSpecPath = cmd.launchSpecPath;
    const timeoutMs = spec.timeoutMs ?? opts.resources.timeoutMs;
    const outputMaxBytes = spec.outputMaxBytes ?? 4 * 1024 * 1024;

    let killed = false;
    let closed = false;
    // Containment bookkeeping (C1/I2): tracks whether any containment kill
    // has been attempted, whether the most recent kill succeeded, and the
    // in-flight kill promise so `settle()` can await drain before resolving.
    // The cgroup kill is the security boundary; a failed kill must NEVER
    // settle with `isolationLevel: 'full'`.
    let containmentKillAttempted = false;
    let containmentKillSucceeded = false;
    let containmentKillError: string | undefined;
    let inFlightKill: Promise<void> | undefined;

    const doCgroupKill = async (): Promise<void> => {
      if (inFlightKill) return inFlightKill;
      if (killed) return;
      killed = true;
      containmentKillAttempted = true;
      inFlightKill = (async (): Promise<void> => {
        try {
          await cgroupRef.kill();
          containmentKillSucceeded = true;
        } catch (err) {
          // Backend failure to write cgroup.kill (cgroup.ts documents this
          // as "surface this and never report full"). Record it so settle()
          // emits a degraded, non-full meta. Still waitEmpty best-effort —
          // if the kernel-side cgroup.kill happens to land despite the
          // write error, we don't want to leak processes.
          containmentKillError = (err as Error).message;
        }
        try { await cgroupRef.waitEmpty(2000); } catch { /* best-effort */ }
      })();
      return inFlightKill;
    };

    const exited = new Promise<BackendRunResult>((resolve) => {
      const outChunks: Buffer[] = [];
      const errChunks: Buffer[] = [];
      let outBytes = 0;
      let errBytes = 0;
      let timedOut = false;
      let outputOverflow = false;
      let settled = false;

      const settle = (exitCode: number): void => {
        if (settled) return;
        settled = true;
        clearTimeout(timer);
        // I2: if a containment kill is in flight, do NOT resolve until it
        // has drained. The "contained" claim must only be asserted after
        // the operation completes.
        const finish = (): void => {
          const so = Buffer.concat(outChunks).toString('utf8');
          const se = Buffer.concat(errChunks).toString('utf8');
          const stderrFinal = outputOverflow
            ? `${se}\noutput cap exceeded (outputMaxBytes=${outputMaxBytes})`
            : se;
          // C1: a containment event occurred AND the kill did not succeed —
          // never claim full. `isolationLevel: 'none'` records that the
          // child may still be unconfined; `degraded: true` plus a reason
          // surfaces the backend failure to the caller.
          const containmentEvent = timedOut || outputOverflow;
          const killFailed = containmentEvent && containmentKillAttempted && !containmentKillSucceeded;
          const meta = killFailed
            ? {
                isolationLevel: 'none' as const,
                backend: 'os' as const,
                degraded: true,
                degradationReasons: [
                  `cgroup containment kill failed: ${containmentKillError ?? 'unknown'}`,
                ],
              }
            : {
                isolationLevel: 'full' as const,
                backend: 'os' as const,
                degraded: false,
                degradationReasons: [] as string[],
              };
          resolve({ exitCode, stdout: so, stderr: stderrFinal, timedOut, meta });
        };
        if (inFlightKill) {
          void inFlightKill.then(finish, finish);
        } else {
          finish();
        }
      };

      // F5: the output cap must be a real memory bound. Previously the chunk was
      // pushed BEFORE the cap check and there was no early return after overflow,
      // so a flooding workload could keep pushing chunks (Buffer.concat would
      // realize all of them) until the cgroup kill landed — memory use ran far
      // past outputMaxBytes. Now: once overflow is set we drop further chunks,
      // and the chunk that crosses the cap is trimmed so the combined buffer
      // never exceeds outputMaxBytes.
      const onData = (which: 'out' | 'err') => (chunk: Buffer) => {
        if (outputOverflow) return; // already over cap: stop buffering, kill is in flight
        const before = outBytes + errBytes;
        if (before + chunk.length > outputMaxBytes) {
          const remaining = outputMaxBytes - before;
          if (remaining > 0) {
            if (which === 'out') { outChunks.push(chunk.subarray(0, remaining)); outBytes += remaining; }
            else { errChunks.push(chunk.subarray(0, remaining)); errBytes += remaining; }
          }
          // COMBINED stdout+stderr cap.
          outputOverflow = true;
          void doCgroupKill();
          return;
        }
        if (which === 'out') { outChunks.push(chunk); outBytes += chunk.length; }
        else { errChunks.push(chunk); errBytes += chunk.length; }
      };
      stdout.on('data', onData('out'));
      stderr.on('data', onData('err'));

      const timer = setTimeout(() => {
        if (!settled && !outputOverflow) {
          timedOut = true;
          void doCgroupKill();
        }
      }, timeoutMs);

      child.on('close', (code) => settle(timedOut || outputOverflow ? 137 : code ?? 0));
      child.on('error', () => settle(1));
    });

    const kill = async (signal?: NodeJS.Signals): Promise<void> => {
      await doCgroupKill();
      // Process-group kill of the trusted launcher only AFTER cgroup kill.
      if (child.exitCode === null) {
        try { child.kill(signal ?? 'SIGKILL'); } catch { /* already gone */ }
      }
    };

    const close = async (): Promise<void> => {
      if (closed) return;
      closed = true;
      try { child.stdin?.end(); } catch { /* best-effort */ }
      if (child.exitCode === null) {
        await doCgroupKill();
        try { child.kill('SIGKILL'); } catch { /* best-effort */ }
      }
      await exited.catch(() => {});
      await cleanupLaunchSpec(launchSpecPath).catch(() => {});
      if (this.activeChild?.child === child) this.activeChild = undefined;
    };

    return {
      stdin: child.stdin!,
      stdout,
      stderr,
      exited,
      kill,
      close,
    };
  }

  // -------------------------------------------------------------------------
  // run()
  // -------------------------------------------------------------------------

  async run(spec: ExecSpec): Promise<BackendRunResult> {
    const proc = await this.spawn({ ...spec, stdin: 'pipe' });
    if (typeof spec.stdin === 'string' || spec.stdin instanceof Uint8Array) {
      proc.stdin.write(spec.stdin);
    }
    proc.stdin.end();
    try {
      const result = await proc.exited;
      // On child close, verify the cgroup is empty before returning.
      if (this.cgroup) {
        try {
          await this.cgroup.waitEmpty(2000);
        } catch {
          // Unexpected remaining processes: kill them and fail the run.
          // I1 note: this kill is a kernel-idempotent follow-up AFTER the
          // per-spawn containment kill (which is structurally once-per-spawn
          // via the inFlightKill guard). It runs only when processes are
          // still present after the child closed — i.e. the per-spawn kill
          // either never fired (no containment event) or the kernel state
          // changed. A second cgroup.kill on an already-killed cgroup is a
          // no-op at the kernel level, so this is safe.
          await this.cgroup.kill().catch(() => {});
          await this.cgroup.waitEmpty(2000).catch(() => {});
          throw new Error('OsSandboxBackend.run: cgroup not empty after child close');
        }
      }
      return result;
    } finally {
      await proc.close();
    }
  }

  // -------------------------------------------------------------------------
  // cleanup()
  // -------------------------------------------------------------------------

  async cleanup(): Promise<void> {
    // Memoized first outcome (T3): repeat calls rethrow the SAME
    // ContainmentCleanupError instance (or resolve identically if the first
    // call resolved). Never logs-and-swallows a containment failure.
    if (this.cleanupOutcome) {
      if (this.cleanupOutcome.error) throw this.cleanupOutcome.error;
      return;
    }
    if (this.cleaned) return;
    this.cleaned = true;
    const containmentReasons: string[] = [];
    try {
      await this.cleanupPartial(containmentReasons);
    } finally {
      const error =
        containmentReasons.length > 0
          ? new ContainmentCleanupError(containmentReasons)
          : undefined;
      this.cleanupOutcome = { error };
    }
    if (this.cleanupOutcome.error) throw this.cleanupOutcome.error;
  }

  /**
   * Reverse-dependency-order cleanup. Aggregates errors without skipping
   * later cleanup. CONTAINMENT steps (process kill via cgroup.kill /
   * waitEmpty, NETWORK teardown via netns.cleanup) push their reason strings
   * into `containmentReasons` — these become the ContainmentCleanupError's
   * reasons. Host-filesystem hygiene steps (rootfs cleanup, launch-spec
   * removal, spec-dir removal) are best-effort soft failures: their reasons
   * are NOT appended to containmentReasons, never become a
   * ContainmentCleanupError, and never carry credential material.
   */
  private async cleanupPartial(containmentReasons: string[]): Promise<void> {
    const softErrors: unknown[] = [];
    const tryContainment = async (fn: () => Promise<void>): Promise<void> => {
      try { await fn(); } catch (err) {
        // Reason strings are the trusted teardown error's .message only — no
        // credential/grant material is ever interpolated here.
        containmentReasons.push((err as Error).message ?? String(err));
      }
    };
    const trySoft = async (fn: () => Promise<void>): Promise<void> => {
      try { await fn(); } catch (err) { softErrors.push(err); }
    };

    // 1. Active helper: cgroup kill/waitEmpty (CONTAINMENT — process teardown).
    // I1 note: cleanup-time kills here and below are kernel-idempotent
    // follow-ups AFTER the per-spawn containment kill (which is structurally
    // once-per-spawn via the inFlightKill guard inside spawn()). cleanup()
    // can run after a completed spawn that already killed the cgroup; a
    // second cgroup.kill on an already-killed cgroup is a no-op at the
    // kernel level, so this is safe.
    if (this.activeChild) {
      const { child, launchSpecPath } = this.activeChild;
      this.activeChild = undefined;
      if (this.cgroup) {
        await tryContainment(async () => { await this.cgroup!.kill(); });
        await tryContainment(async () => { await this.cgroup!.waitEmpty(2000); });
      }
      try { child.kill('SIGKILL'); } catch { /* best-effort */ }
      await trySoft(() => cleanupLaunchSpec(launchSpecPath));
    }

    // 2. Cgroup kill/wait-empty (CONTAINMENT). Same kernel-idempotence note
    // as (1): this is cleanup of the session cgroup, not a containment event.
    // The directory-removal step (cg.cleanup()) is host hygiene — by the
    // time it runs, kill+waitEmpty have already drained the cgroup, so a
    // removal failure can only leak an EMPTY cgroup dir, never a live skill.
    if (this.cgroup) {
      const cg = this.cgroup;
      this.cgroup = undefined;
      await tryContainment(() => cg.kill());
      await tryContainment(() => cg.waitEmpty(2000));
      await trySoft(() => cg.cleanup());
    }

    // 3. Helper/mount/rootfs cleanup (host fs hygiene — soft).
    if (this.layout) {
      const l = this.layout;
      this.layout = undefined;
      await trySoft(() => l.cleanup());
    }

    // 4. The externally owned proxy handle is NOT closed here. The proxy
    // lifecycle is owned by the canonical SandboxRunner + DefaultProxyLauncher;
    // this backend never stores a ProxyHandle. The runner closes the proxy
    // handle AFTER backend.cleanup() returns (teardown order: process →
    // backend runtime/topology → external proxy handle). See the class header
    // for the safety rationale.

    // 5. Netns+nft cleanup (CONTAINMENT — network teardown).
    if (this.netns) {
      const n = this.netns;
      this.netns = undefined;
      await tryContainment(() => n.cleanup());
      // Surface any non-benign teardown errors (EBUSY / EPERM / still-in-use)
      // recorded by the netns cleanup so callers/tests can diagnose a leaked
      // veth/netns. Already-absent (ENOENT) results are treated as success by
      // netns.cleanup() and are NOT recorded, so an empty list with a surviving
      // object means the delete reported the object already gone.
      this.lastNetnsCleanupErrors = n.cleanupErrors;
    }

    // 6. Launch-spec dir removal (host fs hygiene — soft).
    if (this.specDir) {
      const d = this.specDir;
      this.specDir = undefined;
      await trySoft(() => rm(d, { recursive: true, force: true }));
    }

    this.carrier = undefined;
    this.opts = undefined;
    this.proxyCgroupPath = undefined;

    if (softErrors.length > 0) {
      // Soft failures are diagnostic-only — they must never surface as a
      // ContainmentCleanupError and never break the idempotence contract.
      // eslint-disable-next-line no-console
      console.warn('OsSandboxBackend.cleanup: aggregated soft errors', softErrors);
    }
  }
}

// ---------------------------------------------------------------------------
// Validation helpers
// ---------------------------------------------------------------------------

function validatePrepareOptions(opts: BackendPrepareOptions): void {
  if (!opts || typeof opts !== 'object') {
    throw new Error('OsSandboxBackend.prepare: opts is required');
  }
  // Mandatory canonical fields.
  if (typeof opts.proxyAddr !== 'string' || opts.proxyAddr.length === 0) {
    throw new Error('OsSandboxBackend.prepare: proxyAddr is required');
  }
  if (typeof opts.caBundlePath !== 'string' || opts.caBundlePath.length === 0) {
    throw new Error('OsSandboxBackend.prepare: caBundlePath is required');
  }
  if (!opts.runtimeProfile || typeof opts.runtimeProfile !== 'object') {
    throw new Error('OsSandboxBackend.prepare: runtimeProfile is required');
  }
  if (opts.guestSkillRoot !== '/skill') {
    throw new Error(`OsSandboxBackend.prepare: guestSkillRoot must be '/skill', got '${opts.guestSkillRoot}'`);
  }
  if (opts.guestCaBundlePath !== '/etc/skill-ca/ca.pem') {
    throw new Error(`OsSandboxBackend.prepare: guestCaBundlePath must be '/etc/skill-ca/ca.pem', got '${opts.guestCaBundlePath}'`);
  }
  if (typeof opts.snapshotRoot !== 'string' || opts.snapshotRoot.length === 0) {
    throw new Error('OsSandboxBackend.prepare: snapshotRoot is required');
  }
  // Assert the expected snapshot digest FORMAT. The runner owns the full
  // byte-for-byte re-verify (verifySnapshot runs immediately before
  // backend.prepare); the backend only gates on the canonical
  // `sha256:<64 lowercase hex>` shape so a malformed/missing digest can
  // never reach a mount.
  if (!SNAPSHOT_DIGEST_RE.test(opts.expectedSnapshotDigest)) {
    throw new Error('OsSandboxBackend.prepare: expectedSnapshotDigest must match sha256:<64 lowercase hex>');
  }
  if (!opts.runtimeProfile.osRuntime) {
    throw new Error('OsSandboxBackend.prepare: runtimeProfile.osRuntime is required for the os backend');
  }
  // Numeric resolved resources — strict, invalid values throw.
  const r = opts.resources;
  if (!r || typeof r !== 'object') {
    throw new Error('OsSandboxBackend.prepare: resources is required');
  }
  if (!Number.isSafeInteger(r.memoryBytes) || r.memoryBytes <= 0) {
    throw new Error(`OsSandboxBackend.prepare: resources.memoryBytes must be a positive safe integer, got ${r.memoryBytes}`);
  }
  if (!Number.isFinite(r.cpus) || r.cpus <= 0) {
    throw new Error(`OsSandboxBackend.prepare: resources.cpus must be a positive finite number, got ${r.cpus}`);
  }
  if (!Number.isSafeInteger(r.timeoutMs) || r.timeoutMs <= 0) {
    throw new Error(`OsSandboxBackend.prepare: resources.timeoutMs must be a positive safe integer, got ${r.timeoutMs}`);
  }
}

function parseProxyAddr(addr: string): { host: string; port: number } {
  let u: URL;
  try {
    u = new URL(addr);
  } catch (err) {
    throw new Error(`OsSandboxBackend.prepare: proxyAddr is not a valid URL: ${(err as Error).message}`);
  }
  const port = u.port ? Number(u.port) : (u.protocol === 'https:' ? 443 : 80);
  if (!Number.isInteger(port) || port <= 0 || port > 65535) {
    throw new Error(`OsSandboxBackend.prepare: proxyAddr has invalid port ${u.port}`);
  }
  return { host: u.hostname, port };
}

/** Convert fractional CPUs to a cgroup v2 cpu.max quota string. */
function cpuMaxFromCpus(cpus: number): string {
  if (!Number.isFinite(cpus) || cpus <= 0) {
    throw new Error(`cpuMaxFromCpus: cpus must be a positive finite number, got ${cpus}`);
  }
  const period = 100_000;
  const quota = Math.max(1, Math.round(cpus * period));
  return `${quota} ${period}`;
}
