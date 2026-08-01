/**
 * Plan 6 Task 6 — privileged Linux-lane orchestration fixture.
 *
 * Mirrors docker-lane-setup.ts but drives the REAL OS backend
 * (`OsSandboxBackend`) through the canonical orchestration order (no fakes,
 * no injected deps — the production code paths only):
 *
 *   buildSnapshot (immutable, content-addressed)
 *     → resolvePolicy / ResolvedSecrets
 *     → SandboxConfigSchema.parse (defaultBackend:'os', minIsolationLevel:'full')
 *     → new OsSandboxBackend → selectBackend(config, [backend])
 *         (probe-before-rank: the OS backend starts `restricted` and is
 *          promoted to `full` by its real capability probe)
 *     → backend.prepareTopology()        (named netns + veth + base nft table)
 *     → DefaultProxyLauncher.launch({policy, secrets, workDir}, carrier)
 *         (external ownership — the backend never launches a proxy)
 *     → verifySnapshot (LAST fs op)
 *     → backend.prepare({snapshotRoot, proxyAddr, caBundlePath, runtimeProfile,
 *                        guestSkillRoot:'/skill', guestCaBundlePath:'/etc/skill-ca/ca.pem'})
 *
 * Artifact sourcing: `OsSandboxBackend.resolveOsArtifacts()` reads the
 * `OCTOPUS_SANDBOX_OS_*` / `OCTOPUS_SANDBOX_PROXY_*` env vars with well-known
 * fallbacks under the package root. The privileged lane sets them from
 * `OCTOPUS_OS_PROBE_MANIFEST_ROOT` (runtime pair + helper pair) and the
 * repo-local `build/` proxy bundle pair before constructing the backend, so
 * the CI restore step (`OCTOPUS_CI_RUNTIME_ARTIFACT_DIR` → `runtime/`) and a
 * local provisioned root both work without touching the checkout.
 *
 * Cleanup is idempotent and follows the canonical runner teardown order:
 *   active process (caller's responsibility) → backend runtime/topology
 *   (skill cgroup, rootfs, netns, nft) → external proxy handle (owns the CA)
 *   → tmp dirs. The backend never closes the proxy; this fixture does.
 *
 * Leaf-package rule: imports only Node stdlib + this package's own src + the
 * Task 1 harness. NEVER imports from @agentoctopus/{core,registry,adapters,skills}.
 */

import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { mkdtemp, writeFile, rm } from 'node:fs/promises';
import { dirname, join, resolve } from 'node:path';
import { tmpdir } from 'node:os';
import { randomUUID } from 'node:crypto';
import { fileURLToPath } from 'node:url';

import { SandboxConfigSchema, type SandboxConfig, type CredentialGrant } from '../../src/schema.js';
import { buildSnapshot, verifySnapshot, type BuiltSnapshot } from '../../src/snapshot.js';
import { resolvePolicy, type SandboxPolicy } from '../../src/policy.js';
import { selectBackend, type ResolvedRuntimeProfile } from '../../src/backend.js';
import { OsSandboxBackend } from '../../src/os/os-backend.js';
import { DefaultProxyLauncher, type ProxyHandle } from '../../src/proxy/launcher.js';
import type { ResolvedSecrets } from '../../src/proxy/egress-proxy.js';
import type { SandboxSkillDescriptor, SandboxRequest } from '../../src/types.js';
import {
  probePrivilegedLinux,
  makeProbeSkill,
  OS_RUNTIME_MANIFEST_NAME,
  OS_HELPER_MANIFEST_NAME,
  OS_HELPER_BINARY_NAME,
} from './harness.js';
import { LANE_PROBE_SCRIPT, LANE_PROBE_REL, HTTP_PROBE_SCRIPT, HTTP_PROBE_REL } from './lane-probe.js';

const execFileAsync = promisify(execFile);

/** Default per-probe resource caps (tight, so caps/timeout tests stay fast). */
const DEFAULT_TIMEOUT_MS = 2_000;
const DEFAULT_OUTPUT_MAX_BYTES = 32_768;

/** In-root path of the node executable in the `linux-node22` runtime. The
 * manifest ships node at /usr/local/bin/node (see runtimeProfile.osRuntime
 * .nodePath below); several privileged-lane probes previously hardcoded
 * /usr/bin/node, which does NOT exist in the runtime rootfs and made the
 * helper's execve fail ENOENT once it first reached exec (a latent bug masked
 * while the helper died earlier at setgroups). */
export const LANE_NODE = '/usr/local/bin/node';

// ---------------------------------------------------------------------------
// Capability gating
// ---------------------------------------------------------------------------

export interface LinuxLaneAvailability {
  available: boolean;
  reason?: string;
}

/**
 * REAL privileged capability check. Delegates to the Task 1 harness probe
 * (probeOsCaps owner) — never re-implements netns/nft/cgroup probing.
 *
 * Gating contract (M6):
 *   - `OCTOPUS_REQUIRE_PRIVILEGED_LINUX=1`  → unavailable is FATAL (throw, never
 *     skip). Used by the mandatory CI privileged lane, which must prove the
 *     full matrix with zero skips.
 *   - otherwise                            → unavailable skips the case. This is
 *     the expected macOS/dev-host behavior; skipping here is NOT evidence of
 *     privileged coverage.
 *
 * This is intentionally DISTINCT from `OCTOPUS_REQUIRE_OS_SANDBOX=1` (the
 * portable per-file OS smoke gate): the privileged lane asserts the FULL
 * matrix (containment + topology + teardown), the smoke gate asserts a single
 * capability probe.
 */
export async function linuxLaneAvailability(): Promise<LinuxLaneAvailability> {
  const requirePrivileged = process.env.OCTOPUS_REQUIRE_PRIVILEGED_LINUX === '1';
  const result = await probePrivilegedLinux();
  if (!result.available && requirePrivileged) {
    throw new Error(
      `OCTOPUS_REQUIRE_PRIVILEGED_LINUX=1 but privileged Linux capability is unavailable: ${result.reason ?? 'unknown'}`,
    );
  }
  return result;
}

/**
 * Per-test gate. Returns true when the privileged lane can run; skips the
 * case otherwise via `ctx.skip()`. When the capability is unavailable AND
 * `OCTOPUS_REQUIRE_PRIVILEGED_LINUX=1`, `linuxLaneAvailability()` has already
 * thrown in `beforeAll`, so a skip here always means "capability genuinely
 * absent on a non-mandatory host" (e.g. macOS dev).
 *
 * vitest v1 exposes `ctx.skip()` on the PLAIN test context only. Parameterized
 * `it.each` callbacks never receive the context — verified empirically on
 * v1.6.1 that neither the value form nor the `[[v]]` tuple form passes it (the
 * callback gets only the row value(s); `ctx` is `undefined`). Cases needing a
 * per-test skip inside `it.each` must gate with `it.skipIf(flag)` on a
 * module-level flag instead of `ctx.skip()`.
 */
export function needPrivilegedLinux(ctx: unknown, available: boolean): boolean {
  if (!available) { (ctx as { skip: () => void }).skip(); return false; }
  return true;
}

// ---------------------------------------------------------------------------
// Artifact env wiring
// ---------------------------------------------------------------------------

/**
 * Point `resolveOsArtifacts()` at the provisioned runtime/helper artifacts and
 * the repo-local proxy bundle pair. The runtime/helper pair comes from
 * `OCTOPUS_OS_PROBE_MANIFEST_ROOT` (CI restores it from
 * `OCTOPUS_CI_RUNTIME_ARTIFACT_DIR`; the package-root `runtime/` fallback also
 * satisfies this when the manifests live there). The proxy bundle pair is the
 * `bundle-egress-proxy.mjs` output under `packages/sandbox/build/`.
 *
 * Idempotent: env vars already set by the caller win (no override).
 */
function wireArtifactEnv(): void {
  const root = process.env.OCTOPUS_OS_PROBE_MANIFEST_ROOT;
  if (root) {
    process.env.OCTOPUS_SANDBOX_OS_RUNTIME_ARTIFACT ??= join(root, 'linux-node22.rootfs.tar.zst');
    process.env.OCTOPUS_SANDBOX_OS_RUNTIME_MANIFEST ??= join(root, OS_RUNTIME_MANIFEST_NAME);
    process.env.OCTOPUS_SANDBOX_OS_HELPER_MANIFEST ??= join(root, OS_HELPER_MANIFEST_NAME);
    process.env.OCTOPUS_SANDBOX_OS_HELPER_BINARY ??= join(root, OS_HELPER_BINARY_NAME);
  }
  // tests/security/linux-lane-setup.ts → packages/sandbox
  const pkgRoot = resolve(dirname(fileURLToPath(import.meta.url)), '..', '..');
  process.env.OCTOPUS_SANDBOX_PROXY_BUNDLE ??= join(pkgRoot, 'build', 'egress-proxy-server.mjs');
  process.env.OCTOPUS_SANDBOX_PROXY_MANIFEST ??= join(pkgRoot, 'build', 'egress-proxy-server.mjs.manifest.json');
}

// ---------------------------------------------------------------------------
// Sandbox fixture
// ---------------------------------------------------------------------------

export interface LinuxSandboxOptions {
  /**
   * Hosts the skill requests. Combined with the granted hosts via policy
   * resolution (requested ∩ granted). For adversarial cases both stay empty
   * (deny-all). For the topology HTTPS-through-proxy case, request + grant the
   * upstream host.
   */
  request?: SandboxRequest;
  /** Extra InstallationGrant hosts added to config.grants for this snapshot. */
  grantedHosts?: string[];
  /**
   * Hook invoked AFTER prepareTopology() (so the netns exists) but BEFORE the
   * policy is resolved and the proxy launched. Runs on the HOST with the
   * carrier coordinates and returns additional hosts AND credential grants to
   * admit. This lets the topology lane start a host-side upstream on an
   * ephemeral port BEFORE the nft table is fixed (the initial ruleset's input
   * default-drop would otherwise cut it off) and then grant that exact
   * host:port — a non-default port is only admitted via a credential grant
   * (policy Rule 3), and a private/loopback literal additionally needs an exact
   * host grant (Rule 4 → allowPrivateLiteral).
   */
  afterTopology?: (carrier: { netnsName: string; proxyIp: string; proxyPort: number }) => Promise<{ hosts?: string[]; credentials?: CredentialGrant[] }>;
  /** Per-probe overrides folded into the run spec (timeout, output cap). */
  timeoutMs?: number;
  outputMaxBytes?: number;
}

export interface LinuxSandbox {
  /** The concrete OS backend (NOT the SandboxBackend interface) so the lane can read skillCgroupPath. */
  backend: OsSandboxBackend;
  proxy: ProxyHandle;
  snapshot: BuiltSnapshot;
  policy: SandboxPolicy;
  config: SandboxConfig;
  workDir: string;
  /** Named netns coordinates from the linux-static carrier. */
  netnsName: string;
  netnsPath: string;
  proxyIp: string;
  proxyPort: number;
  /** Session nft table name and host-side veth, derived from the kernel post-topology. */
  nftTable: string;
  hostVeth: string;
  /**
   * Skill cgroup path, captured AFTER prepare() (the concrete-class getter is
   * set during prepare and cleared after cleanup). Undefined if read before
   * prepare or after cleanup.
   */
  readonly skillCgroupPath: string | undefined;
  /**
   * Idempotent full teardown in canonical runner order: backend.cleanup()
   * (active child → skill cgroup → rootfs → netns/nft) → proxy.close() (owns
   * the launcher-created CA) → rm tmp.
   */
  cleanup(): Promise<void>;
}

/**
 * Build a real immutable snapshot of the probe skill, resolve policy/secrets,
 * select the OS backend via probe-before-rank, prepare its topology, launch
 * the externally-owned proxy, verify the snapshot, and prepare the backend
 * with the exact canonical options. Returns a handle owning full teardown.
 *
 * The runtimeProfile.osRuntime.nodePath mirrors the reviewed runtime manifest
 * (`linux-node22` ships node at /usr/local/bin/node — see the Dockerfile in
 * build-security-images.mjs, which copies node there from the upstream image).
 * The artifactPath/manifestPath are informational here — the backend
 * resolves+verifies the real artifacts itself via resolveOsArtifacts() and
 * rejects any mismatch fail-closed.
 */
export async function setupLinuxSandbox(opts: LinuxSandboxOptions = {}): Promise<LinuxSandbox> {
  wireArtifactEnv();

  const sessionId = randomUUID().slice(0, 8);
  const workDir = await mkdtemp(join(tmpdir(), 'octopus-llane-'));

  // Materialize the probe skill: the Task 1 harness probe (scripts/probe.js)
  // plus the lane JSON probe (probe.js) and the absolute-form proxy probe.
  const skillSrc = await mkdtemp(join(tmpdir(), 'octopus-llane-skill-'));
  await makeProbeSkill(skillSrc);
  await writeFile(join(skillSrc, LANE_PROBE_REL), LANE_PROBE_SCRIPT, 'utf8');
  await writeFile(join(skillSrc, HTTP_PROBE_REL), HTTP_PROBE_SCRIPT, 'utf8');

  const snapshot = await buildSnapshot({
    sourceDir: skillSrc,
    storeDir: join(workDir, 'store'),
    installationId: `linux-lane-${sessionId}`,
    name: 'linux-lane-probe',
  });

  // Base config drives backend construction + topology; grants are resolved
  // into the policy AFTER prepareTopology so an afterTopology hook can name a
  // host-side upstream that must exist before the nft table is fixed.
  const baseConfig = SandboxConfigSchema.parse({
    defaultBackend: 'os',
    minIsolationLevel: 'full',
    defaults: { timeoutMs: DEFAULT_TIMEOUT_MS, outputMaxBytes: DEFAULT_OUTPUT_MAX_BYTES },
  });

  const descriptor: SandboxSkillDescriptor = {
    identity: snapshot.identity,
    snapshotRoot: snapshot.snapshotRoot,
    request: opts.request ?? {},
  };
  const secrets: ResolvedSecrets = {};

  // The concrete class is retained (not just the SandboxBackend interface) so
  // the lane can read skillCgroupPath — the concrete-only getter Task 5 added.
  const backend = new OsSandboxBackend({ sessionId });
  // Probe-before-rank: the OS backend starts `restricted`; selectBackend
  // probes it FIRST (real capability probe → full) and ranks the post-probe
  // level, so it is selected for minIsolationLevel:'full'.
  const selected = (await selectBackend(baseConfig, [backend])) as OsSandboxBackend;
  if (selected.kind !== 'os') {
    throw new Error(`expected the os backend to be selected, got ${selected.kind}`);
  }

  let cleaned = false;
  let proxy: ProxyHandle | undefined;
  const cleanup = async (): Promise<void> => {
    if (cleaned) return;
    cleaned = true;
    // Canonical runner teardown order: backend runtime/topology FIRST (the
    // skill's nft rules, netns, cgroup, and rootfs go away while the proxy
    // may still be listening — no skill traffic can reach it), THEN the
    // externally-owned proxy handle (which owns the launcher-created CA).
    await selected.cleanup().catch(() => {});
    if (proxy) await proxy.close().catch(() => {});
    await rm(skillSrc, { recursive: true, force: true }).catch(() => {});
    await rm(workDir, { recursive: true, force: true }).catch(() => {});
  };

  let carrier;
  try {
    carrier = await selected.prepareTopology();
  } catch (err) {
    await cleanup();
    throw err;
  }
  if (carrier.kind !== 'linux-static') {
    await cleanup();
    throw new Error(`expected a linux-static carrier, got ${carrier.kind}`);
  }
  // The netns coordinates come from the REAL netns setup; they are needed by
  // the topology assertions (nft read-back, nsenter, ss) before cleanup.
  const netnsName = carrier.skillNamespace.name;
  const netnsPath = carrier.skillNamespace.path;

  // The netns now exists. Let the hook start a host-side upstream and return
  // the extra hosts to grant BEFORE the policy is resolved and the proxy's
  // nft authorization fixes the table (the initial ruleset's input
  // default-drop would otherwise cut a later-started upstream off).
  const hookResult = opts.afterTopology
    ? await opts.afterTopology({ netnsName, proxyIp: carrier.reachableHost, proxyPort: carrier.listenPort })
    : {};
  const hookHosts = hookResult.hosts ?? [];
  const hookCreds = hookResult.credentials ?? [];
  const grantedHosts = [...(opts.grantedHosts ?? []), ...hookHosts];

  // Fail-closed config: only the OS backend is acceptable, and only at full
  // isolation. If the probe cannot promote it to full, selectBackend throws
  // (NoFullBackendError) rather than silently degrading.
  const config = SandboxConfigSchema.parse({
    defaultBackend: 'os',
    minIsolationLevel: 'full',
    defaults: { timeoutMs: DEFAULT_TIMEOUT_MS, outputMaxBytes: DEFAULT_OUTPUT_MAX_BYTES },
    grants: (grantedHosts.length > 0 || hookCreds.length > 0)
      ? [{
          installationId: snapshot.identity.installationId,
          digest: snapshot.identity.digest,
          hosts: grantedHosts,
          // Credential grants admit a non-default upstream port (policy Rule 3);
          // omit the field entirely when the hook grants none.
          ...(hookCreds.length > 0 ? { credentials: hookCreds } : {}),
        }]
      : [],
  });
  const requestDescriptor: SandboxSkillDescriptor = {
    ...descriptor,
    // resolvePolicy intersects granted credentials with request.credentials, so
    // the hook's credential KEYS must also be requested for them to take effect.
    request: {
      ...descriptor.request,
      hosts: [...(descriptor.request.hosts ?? []), ...hookHosts],
      credentials: [...(descriptor.request.credentials ?? []), ...hookCreds.map((c) => c.key)],
    },
  };
  const policy = resolvePolicy(requestDescriptor, config);

  const runtimeProfile: ResolvedRuntimeProfile = {
    id: 'linux-lane',
    bins: ['node'],
    path: '/usr/local/bin',
    osRuntime: {
      artifactPath: process.env.OCTOPUS_SANDBOX_OS_RUNTIME_ARTIFACT ?? '',
      manifestPath: process.env.OCTOPUS_SANDBOX_OS_RUNTIME_MANIFEST ?? '',
      nodePath: '/usr/local/bin/node',
    },
  };

  try {
    // External proxy ownership: the launcher (not the backend) launches
    // exactly one proxy per session against the carrier, and this fixture
    // closes the returned handle — the backend never stores or closes it.
    proxy = await new DefaultProxyLauncher().launch({ policy, secrets, workDir }, carrier);

    // verifySnapshot is the LAST filesystem op before prepare().
    const verified = await verifySnapshot(snapshot.snapshotRoot, snapshot.identity.digest);
    if (!verified) throw new Error('snapshot verification failed');

    await selected.prepare({
      ...policy,
      snapshotRoot: snapshot.snapshotRoot,
      expectedSnapshotDigest: snapshot.identity.digest,
      proxyAddr: proxy.reachableAddr,
      caBundlePath: proxy.caBundlePath,
      runtimeProfile,
      guestSkillRoot: '/skill',
      guestCaBundlePath: '/etc/skill-ca/ca.pem',
    });
  } catch (err) {
    await cleanup();
    throw err;
  }

  // Discover the nft table name + host veth from the kernel, scoped to the
  // session. These are derived (not surfaced on the carrier — the ProxyCarrier
  // shape is canonical and must not grow fields) and only used by the topology
  // assertions; a derivation failure leaves them empty and the topology test
  // re-derives with hard assertions when it needs them.
  const { nftTable, hostVeth } = await deriveNetnsFacts(netnsName);

  return {
    backend: selected,
    proxy,
    snapshot,
    policy,
    config,
    workDir,
    netnsName,
    netnsPath,
    proxyIp: carrier.reachableHost,
    proxyPort: carrier.listenPort,
    nftTable,
    hostVeth,
    get skillCgroupPath() { return selected.skillCgroupPath; },
    cleanup,
  };
}

/**
 * The linux-static carrier deliberately does NOT surface the nft table or
 * host veth name (ProxyCarrier shape is canonical and must not grow fields).
 * Derive them from the kernel: the table is the only `oct_*` table inside the
 * session netns, the host veth is the `oh*` peer in the default namespace.
 * These helpers run argv-only commands and are only meaningful while the
 * topology exists.
 */
async function runArgv(argv: string[], timeoutMs = 15_000): Promise<{ stdout: string; stderr: string; code: number }> {
  const [cmd, ...args] = argv;
  if (!cmd) return { stdout: '', stderr: 'empty argv', code: -1 };
  try {
    const { stdout, stderr } = await execFileAsync(cmd, args, { timeout: timeoutMs });
    return { stdout: String(stdout), stderr: String(stderr), code: 0 };
  } catch (err) {
    const e = err as { stdout?: string; stderr?: string; code?: number | string; message?: string };
    return {
      stdout: String(e.stdout ?? ''),
      stderr: String(e.stderr ?? e.message ?? ''),
      code: typeof e.code === 'number' ? e.code : -1,
    };
  }
}

/**
 * Discover the session's nft table name and host-side veth interface from the
 * kernel, scoped to the session netns. Returns empty strings on any failure —
 * the topology test re-derives them with hard assertions when it needs them.
 */
export async function deriveNetnsFacts(netnsName: string): Promise<{ nftTable: string; hostVeth: string }> {
  let nftTable = '';
  const tables = await runArgv(['ip', 'netns', 'exec', netnsName, 'nft', 'list', 'tables']);
  if (tables.code === 0) {
    const names = tables.stdout
      .split('\n')
      .map((l) => l.trim())
      .filter((l) => l.startsWith('table inet oct_'));
    nftTable = names[0]?.replace(/^table inet /, '') ?? '';
  }
  // The nft table (oct_<salt>) and the host veth (oh<salt>) are BOTH derived
  // from the SAME per-session random salt (netns.ts deriveNames), so this
  // session's host veth name follows directly from the netns-scoped table name
  // resolved above. We deliberately do NOT grep the global `ip link` list for
  // the first oh* interface: on a persistent self-hosted runner that list
  // accumulates STALE oh* veths leaked by pre-reaper runs, and a first-match
  // grep returns one of those (always the same lowest-ifindex leftover) instead
  // of this session's interface — failing the teardown assertion against a name
  // this session never owned, even though its own veth cleaned up correctly.
  const hostVeth = nftTable.startsWith('oct_') ? `oh${nftTable.slice('oct_'.length)}` : '';
  return { nftTable, hostVeth };
}

/** Run argv inside the session netns (argv-only, never shell interpolation). */
export async function execInNetns(netnsName: string, argv: string[], timeoutMs = 15_000): Promise<{ stdout: string; stderr: string; code: number }> {
  return runArgv(['ip', 'netns', 'exec', netnsName, ...argv], timeoutMs);
}

/** `ss -ltnH` rows listening on an exact address:port inside a netns (argv-only). */
export async function ssListenCount(netnsName: string, ip: string, port: number): Promise<number> {
  const res = await execInNetns(netnsName, ['ss', '-ltnH']);
  if (res.code !== 0) return -1;
  const needle = `${ip}:${port}`;
  return res.stdout.split('\n').filter((l) => l.includes(needle)).length;
}

/** `ss -ltnH` rows listening on an exact address:port on the HOST namespace.
 *
 * The egress proxy binds HOST-SIDE: `setupNetns` assigns `proxyIp` to the
 * host-side veth (`hostIf`, which stays on the host — only `skillIf` is moved
 * into the skill netns), and `egress-proxy-server` listens on that host
 * address (see os-backend.ts: the proxy "binds host-side over the carrier").
 * The skill reaches it via the veth peer route, so the listener is visible to
 * `ss` on the HOST, NOT to `ss` run inside the skill netns. Use this to assert
 * the proxy listener exists / is gone. */
export async function hostSsListenCount(ip: string, port: number): Promise<number> {
  const res = await runArgv(['ss', '-ltnH']);
  if (res.code !== 0) return -1;
  const needle = `${ip}:${port}`;
  return res.stdout.split('\n').filter((l) => l.includes(needle)).length;
}

/**
 * Run one lane probe action through the full OS sandbox and parse the single
 * JSON object the probe emits on stdout. Tears the sandbox down fully.
 *
 * The action is delivered as the SECOND ARGV element (`node /skill/probe.js
 * <action>`), never via env — the OS helper clears the environment and
 * installs only a tiny SAFE allowlist, so `PROBE_ACTION` would be stripped.
 * `extraArgs` are appended after the action (e.g. net-probe's host/port).
 */
export async function runLinuxProbe(action: string, options: {
  env?: Record<string, string>;
  extraArgs?: string[];
  command?: string[];
  timeoutMs?: number;
  outputMaxBytes?: number;
  sandbox?: LinuxSandboxOptions;
} = {}): Promise<{ exitCode: number; stdout: string; stderr: string; timedOut: boolean; json: Record<string, unknown> }> {
  const sandbox = await setupLinuxSandbox(options.sandbox ?? {});
  try {
    const command = options.command ?? [LANE_NODE, '/skill/probe.js', action, ...(options.extraArgs ?? [])];
    const result = await sandbox.backend.run({
      command,
      // Env is intentionally minimal: the helper strips it. Kept for the
      // interface contract; nothing here may carry host secrets.
      env: options.env ?? {},
      timeoutMs: options.timeoutMs,
      outputMaxBytes: options.outputMaxBytes,
    });
    return { ...result, json: parseProbeJson(result.stdout) };
  } finally {
    await sandbox.cleanup();
  }
}

/** Extract the first complete JSON object line from probe stdout. */
export function parseProbeJson(stdout: string): Record<string, unknown> {
  for (const line of stdout.split('\n')) {
    const trimmed = line.trim();
    if (!trimmed.startsWith('{')) continue;
    try {
      return JSON.parse(trimmed) as Record<string, unknown>;
    } catch {
      // partial line (output cap may have cut it) — keep scanning
    }
  }
  return {};
}
