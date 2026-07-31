/**
 * Plan 6 Task 1 — Security test harness, immutable-image validation, and real
 * capability probes.
 *
 * This module is the shared foundation every Plan 6 security lane consumes:
 *
 *   - `requirePinnedImageRef` — the single immutable-image gate (regex shared
 *     with SandboxConfigSchema). Rejects tags, `latest`, sentinels, and any
 *     mutable reference. Only `repo@sha256:<64hex>` or `sha256:<64hex>` pass.
 *
 *   - `createHostCanary` — a unique random host file placed at a path NOT
 *     intrinsic to the runtime container (`/host-canary/<uuid>/canary` on the
 *     guest side, but never bind-mounted by the backend). Adversarial cases
 *     assert both the path AND its content are absent from the runtime, so a
 *     leak of either proves a host-mount defect rather than a coincidental
 *     match.
 *
 *   - `PROBE_SCRIPT` / `makeProbeSkill` — a direct-Node probe skill. Every
 *     adversarial probe uses `node:fs`, `node:net`, and `node:child_process`
 *     directly. NO reliance on `/etc/passwd`, `bash`/`sh -c`, `curl`, `wget`,
 *     or shell expansion — the runtime image ships none of those, and asserting
 *     against them would be a tautology.
 *
 *   - `probeDocker` / `probePrivilegedLinux` / `probeMacSandbox` — REAL
 *     capability probes. `probeDocker` runs `docker info` + a disposable
 *     `docker run --rm`. `probePrivilegedLinux` delegates to Plan 4's
 *     `probeOsCaps()` (the single real-privilege probe owner) and derives
 *     availability from `fullLevel(caps) === 'full'` — it never re-implements
 *     netns/veth/nft/cgroup probing and never trusts version strings. On
 *     non-Linux hosts `probeOsCaps()` returns a restricted OsCaps, so this
 *     correctly reports unavailable. `probeMacSandbox` verifies `sandbox-exec`
 *     can ENFORCE a trivial deny rule (behavioral), not merely that the binary
 *     exists.
 *
 * Leaf-package rule: imports only Node stdlib + this package's own
 * `../src/os/probe.js`. NEVER imports from @agentoctopus/{core,registry,
 * adapters,skills}.
 */

import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { randomUUID } from 'node:crypto';
import { mkdtempSync, mkdirSync, writeFileSync, rmSync, realpathSync } from 'node:fs';
import { mkdtemp, mkdir, writeFile, rm } from 'node:fs/promises';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { probeOsCaps, fullLevel } from '../../src/os/probe.js';
import { IMMUTABLE_IMAGE_RE } from '../../src/schema.js';

const execFileAsync = promisify(execFile);

// ---------------------------------------------------------------------------
// Immutable image reference validation
// ---------------------------------------------------------------------------

/**
 * Accepts only immutable image references:
 *   - `registry[:port]/path/repo@sha256:<64 hex>` (repository@digest), and
 *   - `sha256:<64 hex>` (local image ID).
 * Rejects tags (`:latest`, `:22-alpine`), bare names, sentinels
 * (`REPLACE_WITH_DIGEST`), and malformed digests (`sha256:MISSING`).
 *
 * The optional repository prefix MAY itself contain a registry port
 * (`:5000`) — that is a port, not a tag, and is permitted.
 *
 * Uses the SAME regex as `ImmutableImageRefSchema` (`packages/sandbox/src/schema.ts`)
 * — exported as `IMMUTABLE_IMAGE_RE` so the security gate and the production
 * schema can never diverge. Lowercase only (no `i` flag): uppercase repo/digest
 * is rejected, matching the schema.
 */
export function requirePinnedImageRef(name: string, value: string): string {
  if (!IMMUTABLE_IMAGE_RE.test(value)) {
    throw new Error(`${name} must be an immutable repository@sha256 digest or local sha256 image ID`);
  }
  return value;
}

// ---------------------------------------------------------------------------
// Host canary
// ---------------------------------------------------------------------------

export interface HostCanary {
  /** Absolute host directory holding the canary file (NOT mounted by the backend). */
  hostDir: string;
  /** Absolute host path to the canary file. */
  hostPath: string;
  /** Guest-side path the canary would occupy IF the host dir were bind-mounted. The backend deliberately does not mount it, so this path is absent from the runtime. */
  containerPath: string;
  /** Canary content. Unique per call so a coincidental match is impossible. */
  content: string;
  /** Remove the host canary file AND its directory. Idempotent. Synchronous. */
  cleanup: () => void;
}

/**
 * Create a unique random host canary file at a path NOT intrinsic to the
 * container. The `containerPath` follows the `/host-canary/<uuid>/canary`
 * convention so adversarial tests can assert both the path and content are
 * absent from the runtime (a leak proves a host-mount defect).
 *
 * The backend deliberately does NOT bind-mount `hostDir`, so neither
 * `containerPath` nor `content` should be reachable inside the sandbox. If a
 * probe reads either, the host boundary is broken.
 *
 * Synchronous: the brief's test treats `createHostCanary()` as a value, not a
 * Promise (`const c = createHostCanary(); ... c.cleanup();`).
 */
export function createHostCanary(): HostCanary {
  const uuid = randomUUID();
  const content = `octopus-host-only-${uuid}`;
  const hostDir = mkdtempSync(join(tmpdir(), 'octopus-canary-'));
  // Put the canary in a uuid-named subdirectory so the guest-side path
  // (/host-canary/<uuid>/canary) maps cleanly if the dir were mounted.
  const canaryDir = join(hostDir, uuid);
  mkdirSync(canaryDir, { recursive: true });
  const hostPath = join(canaryDir, 'canary');
  writeFileSync(hostPath, content, 'utf8');
  let cleaned = false;
  return {
    hostDir,
    hostPath,
    containerPath: `/host-canary/${uuid}/canary`,
    content,
    cleanup: () => {
      if (cleaned) return;
      cleaned = true;
      try { rmSync(hostDir, { recursive: true, force: true }); } catch { /* idempotent */ }
    },
  };
}

// ---------------------------------------------------------------------------
// Probe skill (direct Node — no shell, no host files, no host tools)
// ---------------------------------------------------------------------------

/**
 * The probe skill body. Executed as `node /skill/scripts/probe.js` with the
 * action selected via `PROBE_ACTION` env var and inputs via other env vars.
 *
 * Every probe uses Node stdlib directly (`node:fs`, `node:net`,
 * `node:child_process`). It MUST NOT depend on `/etc/passwd`, `bash`/`sh -c`,
 * `curl`, `wget`, or shell expansion — the runtime image ships none of those,
 * and asserting against them would be a tautology, not an adversarial check.
 *
 * Actions:
 *   - host-canary-read:   read process.env.HOST_CANARY_PATH; print its contents
 *   - host-canary-write:  overwrite process.env.HOST_CANARY_PATH; print leak marker
 *   - direct-internet:    open a raw TCP socket to PROBE_HOST:PROBE_PORT
 *   - metadata:           print the IMDS-style env vars the runtime exposed
 *   - env-names:           print the names (not values) of all env vars
 *   - output-flood:       write deterministic chunks to stdout until killed
 *   - process-tree:       spawn a detached Node grandchild that writes a marker
 *                         to PROBE_TREE_MARKER_FILE after PROBE_GRANDCHILD_MS
 *                         (default 10000) milliseconds. The marker goes to a
 *                         FILE (the spawn uses stdio:'ignore'), so a lane can
 *                         assert the runtime failed to reap the process tree
 *                         by checking the file appears after the parent dies.
 *   - metadata:           print which IMDS-style env vars are PRESENT (names
 *                         only — never values, which may carry credential URIs)
 */
export const PROBE_SCRIPT = `import { readFileSync, writeFileSync } from 'node:fs';
import { connect } from 'node:net';
import { spawn } from 'node:child_process';
import { hostname } from 'node:os';

const action = process.env.PROBE_ACTION;
const out = (s) => process.stdout.write(s + '\\n');

if (action === 'host-canary-read') {
  const p = process.env.HOST_CANARY_PATH;
  if (!p) { out('no-canary-path'); process.exit(0); }
  try { out('canary:' + readFileSync(p, 'utf8')); } catch (e) { out('canary-read-error:' + e.code); }
  process.exit(0);
}

if (action === 'host-canary-write') {
  const p = process.env.HOST_CANARY_PATH;
  if (!p) { out('no-canary-path'); process.exit(0); }
  try { writeFileSync(p, 'overwritten-by-probe'); out('canary-write-leak'); }
  catch (e) { out('canary-write-blocked:' + e.code); }
  process.exit(0);
}

if (action === 'direct-internet') {
  const host = process.env.PROBE_HOST || 'example.com';
  const port = Number(process.env.PROBE_PORT || 80);
  const sock = connect({ host, port }, () => { out('tcp-connected:' + host + ':' + port); sock.end(); });
  sock.on('error', (e) => { out('tcp-error:' + e.code); process.exit(0); });
  setTimeout(() => { out('tcp-timeout'); sock.destroy(); process.exit(0); }, 5000).unref();
  return;
}

if (action === 'metadata') {
  const names = ['AWS_CONTAINER_CREDENTIALS_RELATIVE_URI', 'ECS_CONTAINER_METADATA_URI_V4',
    'AZURE_FUNCTIONS_ENVIRONMENT', 'GOOGLE_METADATA_HOST'];
  // Names + presence only. NEVER the value — IMDS env vars may carry credential
  // URIs, and "secrets never in stdout/logs". The lane only needs to know
  // whether the metadata var leaked into the sandbox, not its value.
  for (const n of names) if (process.env[n]) out('meta:' + n + '=present');
  out('hostname:' + hostname());
  process.exit(0);
}

if (action === 'env-names') {
  for (const k of Object.keys(process.env)) out('env:' + k);
  process.exit(0);
}

if (action === 'output-flood') {
  const chunk = 'A'.repeat(4096);
  for (let i = 0; i < 100000; i++) process.stdout.write(chunk);
  process.exit(0);
}

if (action === 'process-tree') {
  const ms = Number(process.env.PROBE_GRANDCHILD_MS || 10000);
  const markerFile = process.env.PROBE_TREE_MARKER_FILE;
  if (!markerFile) { out('no-marker-file'); process.exit(0); }
  // Detached grandchild that outlives the parent. The spawn uses stdio:'ignore'
  // (we don't want grandchild stdout in the runtime's captured output), so the
  // marker is written to PROBE_TREE_MARKER_FILE. If the file appears after the
  // parent is killed, the runtime failed to reap the process tree.
  const grandchild = spawn(process.execPath, ['-e',
    'setTimeout(() => { try{require("node:fs").writeFileSync(' + JSON.stringify(markerFile) +
    ',"grandchild-survived:"+Date.now())}catch(e){} }, ' + ms + ')'],
    { detached: true, stdio: 'ignore' });
  grandchild.unref();
  out('spawned-grandchild:' + grandchild.pid);
  process.exit(0);
}

out('unknown-action:' + action);
process.exit(1);
`;

/** Relative path (within a skill dir) where the probe script is written. */
export const PROBE_SCRIPT_REL = 'scripts/probe.js';

/**
 * Write the probe skill into `dir`. The skill has no `SKILL.md` shell tools —
 * it is a direct-Node probe the harness invokes via the subprocess adapter.
 *
 * Returns the absolute path to the written probe script.
 */
export async function makeProbeSkill(dir: string): Promise<string> {
  const scriptsDir = join(dir, 'scripts');
  await mkdir(scriptsDir, { recursive: true });
  const probePath = join(scriptsDir, 'probe.js');
  await writeFile(probePath, PROBE_SCRIPT, 'utf8');
  return probePath;
}

// ---------------------------------------------------------------------------
// Capability probes — REAL, never inferred from version strings
// ---------------------------------------------------------------------------

export interface CapabilityResult {
  available: boolean;
  /** Present (and truthy) iff available === false. Concrete, forwarded reason. */
  reason?: string;
}

// ---- exec helper: argv-only, never shell interpolation ---------------------

interface ExecOut { stdout: string; stderr: string; code: number; }

async function runArgv(argv: string[], timeoutMs = 30_000): Promise<ExecOut> {
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

// ---- probeDocker -----------------------------------------------------------

/**
 * Verify the Docker daemon is reachable (`docker info`) AND can run a trivial
 * disposable container (`docker run --rm`).
 *
 * If `OCTOPUS_TEST_RUNTIME_IMAGE` is set, that image is used for the run probe
 * (the CI-injected runtime image — Task 6 builds it). Otherwise a trivial
 * probe that does NOT depend on the Task 6 image is used (`hello-world`, which
 * exercises the full daemon path without requiring the pinned runtime digest).
 *
 * Returns `available:true` only if BOTH succeed. Never throws.
 */
export async function probeDocker(): Promise<CapabilityResult> {
  // 1. Daemon reachable.
  const info = await runArgv(['docker', 'info', '--format', '{{.ServerVersion}}'], 15_000);
  if (info.code !== 0 || info.stdout.trim().length === 0) {
    return { available: false, reason: `docker daemon unreachable: ${info.stderr.trim() || info.stdout.trim() || 'docker info failed'}` };
  }

  // 2. Disposable container run.
  const image = process.env.OCTOPUS_TEST_RUNTIME_IMAGE;
  const runArgs = image
    ? ['run', '--rm', image, 'node', '-e', 'console.log("runtime-ok")']
    : ['run', '--rm', 'hello-world'];
  const run = await runArgv(['docker', ...runArgs], 90_000);
  if (run.code !== 0) {
    const detail = run.stderr.trim() || run.stdout.trim() || `docker run exited ${run.code}`;
    return { available: false, reason: `docker run --rm failed: ${detail}` };
  }
  return { available: true };
}

// ---- probeDockerImages ------------------------------------------------------

/**
 * probeDocker() PLUS the image refs a suite will actually run being present
 * locally. Each caller passes the refs it uses:
 *
 *   - image-contract falls back to the local `:test` tags
 *     (`agentoctopus/skill-runtime:test` / `agentoctopus/egress-proxy:test`),
 *     so it probes those when OCTOPUS_TEST_*_IMAGE are unset.
 *   - docker-lane/docker-topology REQUIRE immutable digest refs via env
 *     (setupDockerSandbox → requirePinnedImageRef; SandboxConfigSchema rejects
 *     mutable tags), so they probe the env refs and skip when unset.
 *
 * The suites exercise the ACTUAL runtime and egress-proxy images;
 * `security:images` must have built them first (the hosted-docker-proxy lane
 * does). On a plain runner (e.g. the ci.yml unit-test job) the daemon is
 * reachable and probeDocker() passes via `hello-world`, but the trusted
 * images do not exist — docker run then exits 125 and every case fails
 * spuriously. Gate those suites on this stricter probe so they skip cleanly.
 */
export async function probeDockerImages(refs: string[]): Promise<CapabilityResult> {
  const base = await probeDocker();
  if (!base.available) return base;
  for (const ref of refs) {
    const inspect = await runArgv(['docker', 'image', 'inspect', '--format', '{{.Id}}', ref], 30_000);
    if (inspect.code !== 0) {
      return { available: false, reason: `docker image inspect ${ref} failed: ${inspect.stderr.trim() || inspect.stdout.trim()}` };
    }
  }
  return { available: true };
}

// ---- probePrivilegedLinux --------------------------------------------------

/**
 * Canonical reviewed-artifact names. These are the ONLY names the privileged
 * Linux lane provisions (`OCTOPUS_CI_RUNTIME_ARTIFACT_DIR` → `runtime/`) and
 * the ONLY names `resolveOsArtifacts()` looks up by default. The old generic
 * names (`runtime.manifest.json`, `helper.manifest.json`, `helper`) are NOT
 * probed — if a root holds only those, the probe reports unavailable with a
 * reason so a stale provisioning can never be silently trusted.
 */
export const OS_RUNTIME_MANIFEST_NAME = 'linux-node22.manifest.json';
export const OS_HELPER_MANIFEST_NAME = 'os-helper.manifest.json';
export const OS_HELPER_BINARY_NAME = 'os-helper';

/**
 * Delegate to Plan 4's `probeOsCaps()` — the single real-privilege probe
 * owner. `available` is true ONLY when `fullLevel(caps) === 'full'`, i.e. the
 * host PROVED (via real netns/veth/nft/cgroup create+cleanup) that it can grant
 * Linux-namespace + cgroup-v2 isolation.
 *
 * This function MUST NOT re-implement netns/veth/nft/cgroup probing. Version
 * checks alone never qualify.
 *
 * `probeOsCaps` requires real runtime/helper manifest paths. If those are not
 * available in the harness context (env `OCTOPUS_OS_PROBE_MANIFEST_ROOT` unset
 * or manifests absent), the probe returns `available:false` with a forwarded
 * reason — it does NOT fabricate a probe.
 *
 * On macOS, `probeOsCaps()` short-circuits to a restricted OsCaps (every
 * capability bit false), so this correctly reports unavailable.
 */
export async function probePrivilegedLinux(): Promise<CapabilityResult> {
  const root = process.env.OCTOPUS_OS_PROBE_MANIFEST_ROOT;
  if (!root) {
    return { available: false, reason: 'probeOsCaps unavailable: OCTOPUS_OS_PROBE_MANIFEST_ROOT not set' };
  }
  const runtimeManifestPath = join(root, OS_RUNTIME_MANIFEST_NAME);
  const helperManifestPath = join(root, OS_HELPER_MANIFEST_NAME);
  const helperBinaryPath = join(root, OS_HELPER_BINARY_NAME);
  // Fail fast if the manifests/helper are not present — do NOT hand
  // probeOsCaps a missing path that it would itself throw on (it expects real
  // files). Fail closed on absence: the mandatory privileged lane must never
  // silently downgrade to a fabricated probe.
  const manifestProbe = await runArgv(
    ['test', '-f', runtimeManifestPath, '-a', '-f', helperManifestPath, '-a', '-f', helperBinaryPath],
    5_000,
  );
  if (manifestProbe.code !== 0) {
    return {
      available: false,
      reason:
        `probeOsCaps unavailable: canonical artifacts (${OS_RUNTIME_MANIFEST_NAME}, ` +
        `${OS_HELPER_MANIFEST_NAME}, ${OS_HELPER_BINARY_NAME}) not found under ${root}`,
    };
  }
  try {
    const caps = await probeOsCaps({ runtimeManifestPath, helperManifestPath, helperBinaryPath });
    if (fullLevel(caps) === 'full') {
      return { available: true };
    }
    const reason = caps.probeErrors.length > 0
      ? `probeOsCaps restricted: ${caps.probeErrors.join('; ')}`
      : `probeOsCaps restricted: fullLevel=restricted (platform=${caps.platform})`;
    return { available: false, reason };
  } catch (err) {
    return { available: false, reason: `probeOsCaps unavailable: ${String((err as Error).message ?? err)}` };
  }
}

// ---- probeMacSandbox -------------------------------------------------------

/**
 * Verify `sandbox-exec` can ENFORCE a trivial deny rule — not merely that the
 * binary exists. Presence alone does NOT qualify.
 *
 * Behavioral probe: run a sandboxed Node process under an SBPL profile that
 * denies file-write to a canary path. The sandboxed process attempts the write;
 * if the write is DENIED (EPERM/EACCES) the process exits 0 (enforcement
 * worked). If the write SUCCEEDS, the process exits 2 (the profile failed to
 * enforce — a leak). If `sandbox-exec` itself cannot launch the process, that
 * is also unavailable.
 *
 * The profile leaves everything else allowed (`allow default`) so the sandboxed
 * Node binary can execute — only the canary-path write is denied. The canary
 * path resolves through /tmp -> /private/tmp, so the deny targets the resolved
 * private path.
 */
export async function probeMacSandbox(): Promise<CapabilityResult> {
  const sePath = '/usr/bin/sandbox-exec';
  const seProbe = await runArgv(['test', '-x', sePath], 5_000);
  if (seProbe.code !== 0) {
    return { available: false, reason: 'sandbox-exec not present or not executable at /usr/bin/sandbox-exec' };
  }

  const nodeBin = process.execPath;
  const canaryDir = await mkdtemp(join(tmpdir(), 'octopus-macsb-'));
  const canaryFile = join(canaryDir, 'canary.txt');
  // sandbox-exec resolves symlinks before matching SBPL subpaths: /var -> /private/var,
  // /tmp -> /private/tmp. Deny the REAL (resolved) path so the rule actually matches.
  const realCanaryDir = realpathSync(canaryDir);
  const profile = `(version 1)
(allow default)
(deny file-write* (subpath "${realCanaryDir}"))`;

  // Script: exit 0 if the write was DENIED (enforcement works); exit 2 if it
  // SUCCEEDED (leak). Caught EPERM/EACCES => enforcement worked.
  const inlineScript =
    'const fs=require("fs");' +
    `try{fs.writeFileSync(${JSON.stringify(canaryFile)},"hi");process.exit(2)}` +
    'catch(e){if(e.code==="EPERM"||e.code==="EACCES"){process.exit(0)}process.exit(2)}';

  const res = await runArgv([sePath, '-p', profile, nodeBin, '-e', inlineScript], 30_000);
  await rm(canaryDir, { recursive: true, force: true }).catch(() => {});

  if (res.code === 0) {
    return { available: true };
  }
  const detail = res.stderr.trim() || res.stdout.trim() || `sandbox-exec exited ${res.code}`;
  return { available: false, reason: `sandbox-exec deny-rule enforcement failed: ${detail}` };
}
