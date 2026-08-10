/**
 * Windows restricted backend — `WinSandboxBackend`.
 *
 * Wires the primitives into the canonical `SandboxBackend` interface:
 *   - Task 4  `verifyWindowsRuntimeManifest`        (src/windows/runtime-manifest.ts)
 *   - Task 10 `launchSandboxed`/`installGate`/`removeGate`
 *                                                   (src/windows/{job,gate-client}.ts)
 *   - Task 11 `teardownSandbox`                     (src/windows/teardown.ts)
 *   - Task 11 `stageVerifiedCopy`                   (src/windows/stage-copy.ts)
 *
 * PRODUCTION ISOLATION MODEL (Option 3): the skill's node.exe is launched by
 * the native helper under a CreateRestrictedToken-hardened token (privileges
 * stripped, Administrators deny-only, Low integrity) inside a Job Object — NO
 * AppContainer profile, NO LPAC token. Network egress is scoped by the
 * companion service's persistent WFP allowlist keyed on
 * `FWPM_CONDITION_ALE_APP_ID` — the sandbox node.exe DOS path — NOT the
 * (AppContainer-only) PACKAGE_ID. There is therefore NO AppContainer ACL grant
 * and NO loopback capability SID anywhere on the production path (the LPAC
 * `grant-acl`/`sid` helper subcommands + acl.ts/sid.ts wrappers survive only
 * as the diagnostic selftest baseline).
 *
 * RUN-11 LAUNCH LOCATION (CI 31359902308): the Low-integrity child token
 * cannot even OPEN the host toolchain node.exe (e.g. under C:\hostedtoolcache)
 * — the battery's image probes fail err=5 for the Low token at that path,
 * though the SAME file copied under the session's temp dir reads+executes
 * fine (arms H/F). Denial is therefore PATH-based (some parent-directory
 * policy on the toolchain chain blocks the Low label), not the file's DACL
 * or label (the original carries NO_EXPLICIT_LABEL). Production consequently
 * launches node from a SESSION-PRIVATE copy staged into the runner's
 * sessionDir (Step 4c): the copy inherits the default Medium mandatory
 * label, which lets the Low child read+execute it while NO_WRITE_UP still
 * blocks the child from rewriting its own interpreter. The same copy path
 * is the WFP APP_ID key, so the egress gate matches the process actually
 * launched. The host toolchain node.exe is never launched directly under
 * the restricted token.
 *
 * The heavy lifting (Job Object, restricted-token launch, WFP gate, spawn,
 * teardown) is delegated to the native helper exe + the privileged companion
 * service; this TS class owns orchestration, lifecycle, and the
 * cleanup-memoization contract. Isolation target is `restricted` — never
 * `full` (spec §1/§5). It is selectable ONLY via the explicit opt-in
 * `defaultBackend:'windows'` + `minIsolationLevel:'restricted'` (backend.ts
 * selectBackend); `auto` never picks it.
 *
 * The proxy lifecycle is owned EXTERNALLY by the canonical SandboxRunner +
 * DefaultProxyLauncher: prepareTopology() returns the in-process loopback
 * carrier, the runner launches the proxy and passes the resulting
 * `proxyAddr`/`caBundlePath` into prepare(). This backend never launches,
 * stores, or closes a `ProxyHandle`.
 *
 * Lifecycle: new → probe() → prepareTopology() → prepare() → spawn()/run() →
 * cleanup(). Cleanup is idempotent via a memoized FIRST outcome and honors the
 * ContainmentCleanupError contract (see cleanup()).
 *
 * DI seam: all side-effecting collaborators are injectable via the optional
 * `deps` field on the constructor options. Production callers never set it;
 * unit tests on non-Windows hosts inject fakes so ORDER and fail-closed
 * behavior can be exercised without Windows. The seam is never consulted for
 * behavior.
 *
 * Leaf-package rule: Node stdlib only. Never any `@agentoctopus/*` import.
 */

import os from 'node:os';
import path from 'node:path';
import { cp, mkdir } from 'node:fs/promises';
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
import { verifyWindowsRuntimeManifest } from './runtime-manifest.js';
import { launchSandboxed } from './job.js';
import { installGate, removeGate } from './gate-client.js';
import { teardownSandbox } from './teardown.js';
import { stageVerifiedCopy, type StagedCopy } from './stage-copy.js';
import { spawnHelper } from './helper-spawn.js';
import { WindowsSandboxError } from './errors.js';

// ---------------------------------------------------------------------------
// Artifact resolution (probe-time; the runtime profile arrives later, at
// prepare, so probe resolves the trusted runtime manifest from env/package
// the same way the OS backend resolves its artifacts).
// ---------------------------------------------------------------------------

function packageRoot(): string {
  // src/windows/win-backend.ts → packages/sandbox; dist/windows/win-backend.js → packages/sandbox.
  return fileURLToPath(new URL('../..', import.meta.url));
}

function envOr(name: string, fallback: string): string {
  const v = process.env[name];
  return v && v.length > 0 ? v : fallback;
}

function defaultRuntimeManifestPath(): string {
  return envOr(
    'OCTOPUS_SANDBOX_WINDOWS_RUNTIME_MANIFEST',
    path.join(packageRoot(), 'prebuilds', 'windows-x64', 'runtime.manifest.json'),
  );
}

/**
 * Resolve the sandbox node.exe DOS path from the runtime manifest for the
 * gate-availability probe. The probe runs BEFORE prepare() has
 * `opts.runtimeProfile.windowsRuntime.nodePath`, so it reads the `nodePath`
 * field out of the same manifest that `verifyRuntime` just verified. The WFP
 * gate is APP_ID-scoped (Option 3) and the service canonicalizes the path via
 * `FwpmGetAppIdFromFileName0`, which REQUIRES a real, existing node.exe DOS
 * path — so the probe must pass the manifest's nodePath (the trusted,
 * on-host node.exe), never a throwaway path. Returns undefined when the
 * manifest cannot be read/parsed (the probe then reports unavailable).
 */
async function probeNodePath(manifestPath: string): Promise<string | undefined> {
  try {
    const { readFile } = await import('node:fs/promises');
    const parsed = JSON.parse(await readFile(manifestPath, 'utf8')) as { nodePath?: unknown };
    return typeof parsed.nodePath === 'string' && parsed.nodePath.length > 0
      ? parsed.nodePath
      : undefined;
  } catch {
    return undefined;
  }
}

/**
 * RUN-11 default Step-4c collaborator: copy the trusted closure's node.exe
 * into the per-session sessionDir and return the copy path. The copy —
 * not the host toolchain node.exe — is what the restricted-token child
 * launches, because the Low-integrity token cannot open the toolchain path
 * (CI 31359902308 arms H/F). `mkdir` creates the sessionDir only if the
 * snapshot staging has not already (it has — same dir); any failure throws,
 * and prepare() is fail-closed. The copy deliberately keeps the DEFAULT
 * mandatory label (Medium): readable+executable by the Low child, and
 * NO_WRITE_UP blocks the child from rewriting its own interpreter — the
 * stronger posture of the two arms the battery proved.
 */
export async function stageLaunchNode(
  sessionDir: string,
  sourceNodePath: string,
): Promise<string> {
  const dest = path.join(sessionDir, 'node.exe');
  await mkdir(sessionDir, { recursive: true });
  await cp(sourceNodePath, dest);
  return dest;
}

// ---------------------------------------------------------------------------
// DI seam — injectable collaborators (never consulted for behavior)
// ---------------------------------------------------------------------------

export interface WinBackendDeps {
  /**
   * Platform override for the platform gate. Production callers omit it (the
   * real `process.platform` is used); tests inject `'win32'` so the lifecycle
   * runs on a non-Windows host. When omitted on a non-Windows host the gate
   * fires and probe() returns false before touching any artifact.
   */
  platform?: string;
  /** Verify the trusted windowsRuntime closure (Task 4). Throws/→false on failure. */
  verifyRuntime?: (manifestPath: string) => Promise<boolean>;
  /** Helper self-test: spawn `helper probe`, true on exit 0 (Job/SID/LPAC self-check). */
  probeHelper?: () => Promise<boolean>;
  /** True when the companion service is present + responsive (can install/remove a throwaway gate). */
  gateAvailable?: () => Promise<boolean>;
  /** Stage the per-session snapshot+CA copy + re-verify the digest (spec §3). */
  stageCopy?: typeof stageVerifiedCopy;
  /**
   * Stage the launchable node.exe (Step 4c): copy the trusted closure's
   * node.exe into the sessionDir and return the copy path. Run-11 finding —
   * the Low-integrity restricted token cannot open the host toolchain
   * node.exe, so the child launches from a session-private copy. The default
   * is `stageLaunchNode`; tests inject a fake on non-Windows hosts.
   */
  stageLaunchNode?: typeof stageLaunchNode;
  /** Install the per-session WFP gate keyed on the node.exe APP_ID path. */
  installGate?: typeof installGate;
  /** Launch the sandboxed child via the helper `run` subcommand. */
  launchSandboxed?: typeof launchSandboxed;
  /** Terminate the named Job (confirmed dead) + delete profile + copy. */
  teardownSandbox?: typeof teardownSandbox;
  /** Remove the per-session WFP gate. */
  removeGate?: typeof removeGate;
  /** Best-effort host-filesystem removal of the staged copy dir (soft). */
  removeCopyDir?: (dir: string) => Promise<void>;
}

export interface WinSandboxBackendOptions {
  sessionId: string;
  /**
   * Reserved per-session scratch directory for the backend's own state.
   * Currently unused: the staged per-session copy lives under the runner's
   * session dir (derived from `opts.guestSkillRoot` in `prepare`), not here.
   * Defaults to a per-session tmpdir path.
   */
  workDir?: string;
  /** Injectable collaborators. Production callers omit this. */
  deps?: WinBackendDeps;
}

export class WinSandboxBackend implements SandboxBackend {
  readonly kind = 'windows' as const;

  private readonly sessionId: string;
  private readonly workDir: string;
  private readonly deps: WinBackendDeps;

  private probed = false;
  private probeOk = false;
  private carrier: Extract<ProxyCarrier, { kind: 'in-process' }> | undefined;
  private opts: BackendPrepareOptions | undefined;
  private staged: StagedCopy | undefined;
  private pkgMoniker: string | undefined;
  private jobName: string | undefined;
  private copyDir: string | undefined;
  /** Session-private node.exe copy the child launches from (run-11 Step 4c). */
  private launchNodePath: string | undefined;
  private gateInstalled = false;
  private cleaned = false;
  /**
   * Memoized FIRST cleanup outcome (ContainmentCleanupError contract). Once
   * set, repeat cleanup() calls rethrow the same ContainmentCleanupError or
   * resolve identically.
   */
  private cleanupOutcome: { error?: ContainmentCleanupError } | undefined;
  /**
   * One-shot ExecSpec.stdin payload stashed by run() and consumed by the next
   * spawn() (forwarded to the launcher's HelperSpawnOptions.stdin). Undefined
   * for the persistent spawn() path, whose stdin is a live pipe.
   */
  private pendingOneShotStdin: string | Uint8Array | undefined;

  constructor(opts: WinSandboxBackendOptions) {
    if (!opts.sessionId || typeof opts.sessionId !== 'string') {
      throw new Error('WinSandboxBackend: sessionId is required');
    }
    this.sessionId = opts.sessionId;
    this.workDir = opts.workDir ?? path.join(os.tmpdir(), `oct-win-backend-${this.sessionId}`);
    this.deps = opts.deps ?? {};
    this.pkgMoniker = `AgentOctopus.Sandbox.${this.sessionId}`;
    this.jobName = `OctJob-${this.sessionId}`;
  }

  get isolationLevel(): IsolationLevel {
    return this.probed && this.probeOk ? 'restricted' : 'none';
  }

  // -------------------------------------------------------------------------
  // probe()
  // -------------------------------------------------------------------------

  async probe(): Promise<boolean> {
    // Platform gate FIRST — on non-Windows we never touch the artifacts (the
    // helper/service/runtime are Windows PE binaries, absent elsewhere). An
    // injected `platform`/probe override drives the whole probe so the
    // lifecycle can be exercised on a non-Windows host.
    const platform = this.deps.platform ?? process.platform;
    if (platform !== 'win32') {
      this.probed = true;
      this.probeOk = false;
      return false;
    }

    // (a)+(b) Trusted supply chain: verify the windowsRuntime closure manifest
    // (Node exe + bootstrap.cjs + vendored undici). A verification failure is
    // an AVAILABILITY signal, never a rejection — probe returns false.
    const verifyRuntime =
      this.deps.verifyRuntime ??
      (async (manifestPath: string) => {
        await verifyWindowsRuntimeManifest(manifestPath);
        return true;
      });
    try {
      const ok = await verifyRuntime(defaultRuntimeManifestPath());
      if (!ok) {
        this.probed = true;
        this.probeOk = false;
        return false;
      }
    } catch {
      this.probed = true;
      this.probeOk = false;
      return false;
    }

    // Helper self-test: create a Job Object, derive a loopback capability SID,
    // and create+delete a throwaway LPAC profile under the verified runtime,
    // then tear it down. Any failure → unavailable.
    const probeHelper =
      this.deps.probeHelper ??
      (async () => {
        try {
          const res = await spawnHelper(['probe']);
          return res.exitCode === 0;
        } catch {
          return false;
        }
      });
    let helperOk = false;
    try {
      helperOk = await probeHelper();
    } catch {
      helperOk = false;
    }
    if (!helperOk) {
      this.probed = true;
      this.probeOk = false;
      return false;
    }

    // (c) The privileged companion service must be present and able to install
    // + remove a throwaway per-session WFP gate. Absent service → NO degraded
    // mode (Decision 4) → unavailable.
    const gateAvailable = this.deps.gateAvailable ?? (async () => this.defaultGateAvailable());
    let gateOk = false;
    try {
      gateOk = await gateAvailable();
    } catch {
      gateOk = false;
    }
    this.probed = true;
    this.probeOk = gateOk;
    return gateOk;
  }

  /**
   * Default gate-availability self-check: install a throwaway gate keyed on the
   * REAL sandbox node.exe APP_ID path, then remove it. Any failure →
   * unavailable. Uses a dedicated probe session id so a leftover throwaway gate
   * can never collide with a real session.
   *
   * CRITICAL (task-37 contract): the gate is APP_ID-scoped and the service
   * canonicalizes `appIdPath` via `FwpmGetAppIdFromFileName0`, which fails on a
   * nonexistent path. So the probe MUST pass the manifest's real, existing
   * node.exe DOS path — a throwaway/derived path would make the service reject
   * install-gate and the probe would WRONGLY report the gate unavailable.
   */
  private async defaultGateAvailable(): Promise<boolean> {
    const probeSession = `probe-${this.sessionId}`;
    try {
      const appIdPath = await probeNodePath(defaultRuntimeManifestPath());
      if (!appIdPath) return false;
      await installGate({
        sessionId: probeSession,
        appIdPath,
        proxyHost: '127.0.0.1',
        proxyPort: 9, // discard port — a throwaway endpoint, never dialed
        jobName: `OctJob-${probeSession}`,
        proxyV6Loopback: false,
      });
      await removeGate(probeSession);
      return true;
    } catch {
      return false;
    }
  }

  // -------------------------------------------------------------------------
  // prepareTopology()
  // -------------------------------------------------------------------------

  async prepareTopology(): Promise<ProxyCarrier> {
    if (this.carrier) return this.carrier;
    // The egress proxy runs as a normal host process on loopback. Reachability
    // is enforced by the loopback capability + persistent WFP allowlist (§4c),
    // NOT assumed. Identical carrier shape to the VM backend.
    this.carrier = { kind: 'in-process', listenHost: '127.0.0.1', reachableHost: '127.0.0.1' };
    return this.carrier;
  }

  // -------------------------------------------------------------------------
  // prepare()
  // -------------------------------------------------------------------------

  async prepare(opts: BackendPrepareOptions): Promise<void> {
    // Step 1: validate options FIRST (pure input check, no side effects).
    this.validatePrepareOptions(opts);

    // Step 2: probe must have succeeded.
    if (!this.probed || !this.probeOk) {
      throw new Error('WinSandboxBackend.prepare: probe() must succeed first');
    }

    // Step 3: topology must have run. The proxy itself is launched and owned
    // EXTERNALLY by the canonical SandboxRunner + DefaultProxyLauncher between
    // prepareTopology() and prepare(); this backend consumes only the supplied
    // `proxyAddr`/`caBundlePath` and must never launch or close a proxy.
    if (!this.carrier) {
      throw new Error('WinSandboxBackend.prepare: prepareTopology() must run before prepare()');
    }

    // Step 4: stage the per-session copy of the verified snapshot + CA and
    // re-verify it byte-for-byte against expectedSnapshotDigest (spec §3,
    // Decision 3). A digest mismatch throws before any ACL grant or gate
    // install — the copy is never used unverified.
    //
    // The staged copy lands where the runner declared: path.dirname of the
    // runner-computed guestSkillRoot (the runner's per-session sessionDir).
    // This keeps the staged copy inside the runner's sessionDir so the
    // runner's session cleanup owns wholesale removal, and the backend's
    // own cleanup handles only the Job / gate / profile.
    const stageCopy = this.deps.stageCopy ?? stageVerifiedCopy;
    this.copyDir = path.dirname(opts.guestSkillRoot);
    this.staged = await stageCopy({
      snapshotRoot: opts.snapshotRoot,
      caBundlePath: opts.caBundlePath,
      expectedDigest: opts.expectedSnapshotDigest,
      sessionDir: this.copyDir,
    });

    // Step 4b: assert the staged copy landed exactly where the runner
    // declared — the literal guest-path contract shared by every backend
    // (docker asserts '/skill'; os/vm assert their literals; windows asserts
    // the staged-copy paths). Fail-closed on mismatch.
    if (this.staged.guestSkillRoot !== opts.guestSkillRoot) {
      throw new WindowsSandboxError(
        `staged guestSkillRoot mismatch: expected '${opts.guestSkillRoot}', got '${this.staged.guestSkillRoot}'`,
      );
    }
    if (this.staged.guestCaBundlePath !== opts.guestCaBundlePath) {
      throw new WindowsSandboxError(
        `staged guestCaBundlePath mismatch: expected '${opts.guestCaBundlePath}', got '${this.staged.guestCaBundlePath}'`,
      );
    }

    try {
      // Step 5 (Option 3): NO AppContainer ACL grant. Under the
      // restricted-token production model there is no AppContainer token, so a
      // package ACL grant (`grantRead`) would be meaningless — the restricted
      // child reads the staged copy via NORMAL file ACLs (the staged copy under
      // the runner's sessionDir is readable by the user the helper runs as).
      // OPEN EMPIRICAL ITEM: if the windows-restricted CI lane shows the
      // Low-integrity restricted token CANNOT read the staged copy, the fix is
      // a least-privilege Users/Everyone read grant on the staged dir — do NOT
      // pre-build it here.

      // Step 4c (run-11): stage the session-private node.exe COPY the child
      // launches from. The host toolchain node.exe (e.g. under
      // C:\hostedtoolcache) is UNOPENABLE by the Low-integrity restricted
      // token (image probes fail err=5 on that path — CI 31359902308); the
      // same bytes under the session's temp dir open fine. The copy keeps the
      // default Medium mandatory label: the Low child can read+execute it but
      // NO_WRITE_UP blocks it from rewriting its own interpreter. Done BEFORE
      // the gate install so a staging failure never leaves a live gate, and
      // so the gate's APP_ID can key on the copy.
      const win = opts.runtimeProfile.windowsRuntime!;
      const stageNode = this.deps.stageLaunchNode ?? stageLaunchNode;
      this.launchNodePath = await stageNode(this.copyDir, win.nodePath);

      // Step 6: install the per-session WFP allowlist keyed on the sandbox
      // node.exe COPY's APP_ID path (run-11: the gate must match the image the
      // child actually executes — the staged copy, never the toolchain path) +
      // proxy endpoint (§4c). proxyV6Loopback is computed from whether the
      // proxy actually listens on ::1 — the service must not guess. The APP_ID
      // path MUST be a real, existing DOS path or the service's
      // FwpmGetAppIdFromFileName0 rejects the install (fail-closed) — the copy
      // just staged satisfies this.
      const { host: proxyHost, port: proxyPort } = parseProxyAddr(opts.proxyAddr);
      const install = this.deps.installGate ?? installGate;
      await install({
        sessionId: this.sessionId,
        appIdPath: this.launchNodePath,
        proxyHost,
        proxyPort,
        jobName: this.jobName!,
        proxyV6Loopback: proxyHost === '::1' || proxyHost === '[::1]',
      });
      this.gateInstalled = true;

      this.opts = opts;
    } catch (err) {
      // Clean partial state and rethrow. NEVER convert a setup failure into a
      // run — prepare() throws and the selector fails closed. A gate installed
      // before a later step failed is fail-closed residue (block-by-default);
      // the runner's cleanup() pass reclaims it.
      throw err;
    }
  }

  // -------------------------------------------------------------------------
  // spawn()
  // -------------------------------------------------------------------------

  async spawn(spec: SpawnSpec): Promise<SandboxProcess> {
    if (!this.opts || !this.staged) {
      throw new Error('WinSandboxBackend.spawn called before prepare()');
    }
    const opts = this.opts;
    const staged = this.staged;
    const win = opts.runtimeProfile.windowsRuntime!;

    // The helper `run` subcommand relays the child's stdio and propagates the
    // child exit code verbatim. For a persistent session we keep the helper
    // process alive and pipe its stdio; for the one-shot run() path the
    // helper exits with the child. The DI seam injects launchSandboxed so the
    // persistent-stdio shape is exercised without Windows.
    //
    // NOTE: the production helper launch is a long-lived stdio relay; the
    // one-shot launchSandboxed wrapper (Task 10) captures {exitCode, stdout,
    // stderr}. The persistent spawn() path uses the same helper via the
    // injected launcher and adapts the result into a SandboxProcess. Tests
    // inject launchSandboxed; production wiring binds the stdio relay.
    //
    // Stdin: run() stashes its one-shot ExecSpec.stdin payload on
    // `pendingOneShotStdin` before delegating here; it is forwarded to the
    // launcher via HelperSpawnOptions.stdin so spawnHelper writes + closes it
    // on the helper's stdin (the helper relays it to the sandboxed child).
    // The persistent spawn() path has no buffered payload (SpawnSpec.stdin is
    // 'pipe'), so this is undefined there and the helper's stdin stays a live
    // pipe — its streaming is a Task-12 concern (the reviewer scoped the
    // one-shot adaptation as the v1 boundary).
    const launch = this.deps.launchSandboxed ?? launchSandboxed;
    const memMb = Math.max(1, Math.round(opts.resources.memoryBytes / (1024 * 1024)));
    const { host: proxyHost, port: proxyPort } = parseProxyAddr(opts.proxyAddr);
    const oneShotStdin = this.pendingOneShotStdin;
    this.pendingOneShotStdin = undefined;

    const resultPromise = launch(
      {
        jobName: this.jobName!,
        memMb,
        pkgMoniker: this.pkgMoniker!,
        restrictedToken: true, // Option-3 production mode: hardened restricted token, no LPAC
        proxy: { host: proxyHost, port: proxyPort },
        caPath: staged.guestCaBundlePath,
        bootstrapPath: win.bootstrapPath,
        // Run-11: launch the session-private node.exe copy staged in prepare
        // (Step 4c) — the Low-integrity token cannot open the host toolchain
        // node.exe; the WFP APP_ID gate is keyed on this same path.
        nodePath: this.launchNodePath!,
        argv: spec.command,
      },
      oneShotStdin !== undefined ? { stdin: oneShotStdin } : undefined,
    );

    return adaptHelperResult(resultPromise, opts, spec, oneShotStdin);
  }

  // -------------------------------------------------------------------------
  // run()
  // -------------------------------------------------------------------------

  async run(spec: ExecSpec): Promise<BackendRunResult> {
    // Stash the one-shot stdin payload so spawn() forwards it to the launcher's
    // HelperSpawnOptions.stdin — spawnHelper writes it to the helper's stdin
    // and closes it (the helper relays it to the sandboxed child). This honors
    // the ExecSpec.stdin contract ("run() writes stdin then closes stdin")
    // against the REAL child, not a readerless buffer.
    if (typeof spec.stdin === 'string' || spec.stdin instanceof Uint8Array) {
      this.pendingOneShotStdin = spec.stdin;
    }
    const proc = await this.spawn({ ...spec, stdin: 'pipe' });
    // The SandboxProcess.stdin pipe is a no-op sink for the one-shot path (the
    // payload already flowed to the launcher above); close it so a caller that
    // also writes here does not block.
    proc.stdin.end();
    try {
      return await proc.exited;
    } finally {
      await proc.close();
    }
  }

  // -------------------------------------------------------------------------
  // cleanup()
  // -------------------------------------------------------------------------

  async cleanup(): Promise<void> {
    // Memoized first outcome: repeat calls rethrow the SAME
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
   * Spec §2 cleanup ordering. CONTAINMENT steps push their reason strings into
   * `containmentReasons` (these become the ContainmentCleanupError's reasons).
   * Host-filesystem hygiene steps are best-effort soft failures.
   *
   * ORDERING MATTERS (§4c):
   *   1. Terminate the named Job (KILL_ON_JOB_CLOSE) and CONFIRM it is empty.
   *      If the Job cannot be confirmed dead → KEEP the WFP filters and record
   *      a containment failure (never delete the gate while the process may
   *      still be alive). teardownSandbox throws in exactly that case.
   *   2. Only after the Job is confirmed dead, remove the per-session WFP
   *      filters. A removal failure here leaves a leftover BLOCK filter —
   *      fail-closed residue / host hygiene, a SOFT degradation, NOT a
   *      containment breach.
   *   3. Delete the staged copy wholesale (host hygiene — soft). Under Option 3
   *      no AppContainer profile is ever created; the helper's teardown still
   *      issues DeleteAppContainerProfile for the (nonexistent) profile, which
   *      is a harmless no-op, plus the copy removal on the confirmed-dead path.
   *      removeCopyDir is the TS-side best-effort sweep of the staged dir.
   *      (C-side follow-up: drop the now-dead profile-delete from the helper's
   *      teardown subcommand.)
   */
  private async cleanupPartial(containmentReasons: string[]): Promise<void> {
    const softErrors: unknown[] = [];
    const trySoft = async (fn: () => Promise<void>): Promise<void> => {
      try { await fn(); } catch (err) { softErrors.push(err); }
    };

    // 1. Terminate the Job + confirm dead (CONTAINMENT — process teardown).
    //    On failure we KEEP the gate and do NOT remove it: the skill may still
    //    be alive, so the WFP allowlist must stay. Record containment and stop.
    let jobConfirmedDead = true;
    if (this.jobName && this.pkgMoniker && this.copyDir) {
      const teardown = this.deps.teardownSandbox ?? teardownSandbox;
      try {
        await teardown({
          jobName: this.jobName,
          pkgMoniker: this.pkgMoniker,
          copyDir: this.copyDir,
        });
      } catch (err) {
        jobConfirmedDead = false;
        containmentReasons.push((err as Error).message ?? String(err));
      }
    }

    // 2. Remove the WFP gate ONLY after the Job is confirmed dead. A removal
    //    failure here is fail-closed residue (a leftover block filter keeps
    //    restricting) — soft, never a ContainmentCleanupError.
    if (jobConfirmedDead && this.gateInstalled) {
      const remove = this.deps.removeGate ?? removeGate;
      await trySoft(async () => {
        await remove(this.sessionId);
        this.gateInstalled = false;
      });
    }

    // 3. Delete the staged copy dir (host fs hygiene — soft). Under Option 3
    //    the helper's teardown performs a no-op profile delete (no AppContainer
    //    profile exists) plus the copy removal on the confirmed-dead path; this
    //    is the TS-side best-effort sweep of the session stage dir.
    if (jobConfirmedDead && this.copyDir) {
      const dir = this.copyDir;
      const removeCopyDir =
        this.deps.removeCopyDir ??
        (async (d: string) => {
          const { rm } = await import('node:fs/promises');
          await rm(d, { recursive: true, force: true });
        });
      await trySoft(() => removeCopyDir(dir));
    }

    this.carrier = undefined;
    this.opts = undefined;
    this.staged = undefined;
    this.copyDir = undefined;

    if (softErrors.length > 0) {
      // Soft failures are diagnostic-only — they must never surface as a
      // ContainmentCleanupError and never break the idempotence contract.
      // eslint-disable-next-line no-console
      console.warn('WinSandboxBackend.cleanup: aggregated soft errors', softErrors);
    }
  }

  // -------------------------------------------------------------------------
  // Validation
  // -------------------------------------------------------------------------

  private validatePrepareOptions(opts: BackendPrepareOptions): void {
    if (!opts || typeof opts !== 'object') {
      throw new Error('WinSandboxBackend.prepare: opts is required');
    }
    if (typeof opts.proxyAddr !== 'string' || opts.proxyAddr.length === 0) {
      throw new Error('WinSandboxBackend.prepare: proxyAddr is required');
    }
    if (typeof opts.caBundlePath !== 'string' || opts.caBundlePath.length === 0) {
      throw new Error('WinSandboxBackend.prepare: caBundlePath is required');
    }
    if (typeof opts.snapshotRoot !== 'string' || opts.snapshotRoot.length === 0) {
      throw new Error('WinSandboxBackend.prepare: snapshotRoot is required');
    }
    if (!opts.runtimeProfile || typeof opts.runtimeProfile !== 'object') {
      throw new Error('WinSandboxBackend.prepare: runtimeProfile is required');
    }
    // Assert the expected snapshot digest FORMAT. The runner owns the full
    // byte-for-byte re-verify (verifySnapshot runs immediately before
    // backend.prepare); stage-copy re-verifies the COPY. The backend gates on
    // the canonical `sha256:<64 lowercase hex>` shape so a malformed/missing
    // digest can never reach a grant or gate install.
    if (!SNAPSHOT_DIGEST_RE.test(opts.expectedSnapshotDigest)) {
      throw new Error('WinSandboxBackend.prepare: expectedSnapshotDigest must match sha256:<64 lowercase hex>');
    }
    if (!opts.runtimeProfile.windowsRuntime) {
      throw new Error('WinSandboxBackend.prepare: runtimeProfile.windowsRuntime is required for the windows backend');
    }
    const r = opts.resources;
    if (!r || typeof r !== 'object') {
      throw new Error('WinSandboxBackend.prepare: resources is required');
    }
    if (!Number.isSafeInteger(r.memoryBytes) || r.memoryBytes <= 0) {
      throw new Error(`WinSandboxBackend.prepare: resources.memoryBytes must be a positive safe integer, got ${r.memoryBytes}`);
    }
    if (!Number.isFinite(r.cpus) || r.cpus <= 0) {
      throw new Error(`WinSandboxBackend.prepare: resources.cpus must be a positive finite number, got ${r.cpus}`);
    }
    if (!Number.isSafeInteger(r.timeoutMs) || r.timeoutMs <= 0) {
      throw new Error(`WinSandboxBackend.prepare: resources.timeoutMs must be a positive safe integer, got ${r.timeoutMs}`);
    }
  }
}

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function parseProxyAddr(addr: string): { host: string; port: number } {
  let u: URL;
  try {
    u = new URL(addr);
  } catch (err) {
    throw new WindowsSandboxError(`proxyAddr is not a valid URL: ${(err as Error).message}`);
  }
  const port = u.port ? Number(u.port) : (u.protocol === 'https:' ? 443 : 80);
  if (!Number.isInteger(port) || port <= 0 || port > 65535) {
    throw new WindowsSandboxError(`proxyAddr has invalid port ${u.port}`);
  }
  return { host: u.hostname, port };
}

/**
 * Adapt the one-shot helper `run` result into a SandboxProcess. The helper
 * relays the child's stdio and propagates its exit code verbatim; a non-zero
 * exit is a RESULT, not a wrapper failure. For the DI-driven test path the
 * launcher resolves with {exitCode, stdout, stderr}; the streams expose that
 * captured output and `exited` resolves the BackendRunResult.
 *
 * `oneShotStdin` (run() only) has ALREADY been forwarded to the launcher's
 * HelperSpawnOptions.stdin, so the payload reached the real child; the
 * returned `stdin` PassThrough is drained (a no-op sink) so any incidental
 * write to it cannot block. For the persistent spawn() path `oneShotStdin` is
 * undefined and the live-pipe streaming of `stdin` is a Task-12 concern.
 */
function adaptHelperResult(
  resultPromise: Promise<{ exitCode: number; stdout: string; stderr: string }>,
  opts: BackendPrepareOptions,
  spec: SpawnSpec,
  oneShotStdin?: string | Uint8Array,
): SandboxProcess {
  const stdin = new PassThrough();
  const stdout = new PassThrough();
  const stderr = new PassThrough();
  const timeoutMs = spec.timeoutMs ?? opts.resources.timeoutMs;
  // Drain the stdin sink: for the one-shot path the payload already flowed to
  // the launcher, so bytes written here are discarded. resume() keeps the
  // writable side from filling its buffer and blocking a caller.
  if (oneShotStdin !== undefined) stdin.resume();

  const exited = (async (): Promise<BackendRunResult> => {
    let timedOut = false;
    const timeout = new Promise<never>((_, reject) => {
      const t = setTimeout(() => {
        timedOut = true;
        reject(new WindowsSandboxError(`helper run timed out after ${timeoutMs}ms`));
      }, timeoutMs);
      // Do not keep the event loop alive on the timer.
      if (typeof t.unref === 'function') t.unref();
    });
    try {
      const res = await Promise.race([resultPromise, timeout]);
      stdout.end(res.stdout);
      stderr.end(res.stderr);
      return {
        exitCode: res.exitCode,
        stdout: res.stdout,
        stderr: res.stderr,
        timedOut: false,
        meta: {
          isolationLevel: 'restricted',
          backend: 'windows',
          degraded: false,
          degradationReasons: [],
        },
      };
    } catch (err) {
      stdout.end();
      stderr.end();
      if (timedOut) {
        return {
          exitCode: 137,
          stdout: '',
          stderr: `helper run timed out after ${timeoutMs}ms`,
          timedOut: true,
          meta: {
            isolationLevel: 'restricted',
            backend: 'windows',
            degraded: true,
            degradationReasons: [(err as Error).message],
          },
        };
      }
      throw err;
    }
  })();

  let closed = false;
  return {
    stdin,
    stdout,
    stderr,
    exited,
    kill: async () => {
      // The named Job is the containment boundary; a kill request is realized
      // by the helper's KILL_ON_JOB_CLOSE on teardown. The one-shot launcher
      // holds no separate handle here.
    },
    close: async () => {
      if (closed) return;
      closed = true;
      try { stdin.end(); } catch { /* best-effort */ }
      await exited.catch(() => {});
    },
  };
}
