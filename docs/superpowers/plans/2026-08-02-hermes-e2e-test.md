# Hermes ↔ AgentOctopus E2E Test + Docker Egress Fix Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Make the Docker sandbox actually able to reach the network through the egress proxy (bootstrap.cjs + vendored undici), wire structured telemetry (routing scores, intent, sandbox meta, adapter success, output validation, request-level terminal events) end-to-end through a new `ExecutionContext` and a gateway debug endpoint, and ship a machine-only Claude Code skill (`hermes-e2e-test/run.mjs`) that proves the full 5-stage chain — Hermes→`octopus ask` (wrapper forensics) and gateway `/ask` (telemetry) — as two independent integration smokes.

**Architecture:** Five phases. P0 unblocks sandbox execution via config prerequisites (`runtimeProfiles.node`, pinned docker/proxy images, `installationId`). P1 fixes distroless-guest networking: the runtime image COPYs a read-only `/opt/octopus-boot/` (bootstrap.cjs + vendored undici), and `docker-backend.ts` injects `NODE_OPTIONS=--require …bootstrap.cjs` so built-in Node `fetch` (undici) routes through the `HTTPS_PROXY` egress proxy via a vendored `ProxyAgent` assigned to `globalThis[Symbol.for('undici.globalDispatcher.1')]`. P2 fixes the weather/ip-lookup skill manifests (`requires.bins [curl]→[node]` + `sandbox.hosts`). P3 threads a new `ExecutionContext` (traceId/executionId/apiKeyId) through `Router`/`Executor`/`SandboxRunner` emitting layered events (`sandbox.completed`, `adapter.completed`, `request.completed/failed`, `routing.completed`) that a gateway debug endpoint aggregates by `traceId` into a ring buffer with a one-directional `status` lifecycle. P4 is the machine-only orchestrator.

**Tech Stack:** TypeScript ESM (NodeNext, ES2022), Zod v4, vitest v1.6.1, Node v22+ (guest runtime is Node v22 on distroless/cc-debian12); vendored undici 6.24.1; Docker; Express (gateway); Commander (CLI).

## Global Constraints

- **Coding subagent dispatch path is RESTORED** — use SDD (fresh implementer subagent per task + task review after each). Inline execution only as fallback.
- ESM TypeScript, NodeNext, ES2022, Zod v4, vitest v1.6.1, Node v22+.
- **Scoped builds only** — never bare `pnpm build` at repo root. Use `pnpm --filter @agentoctopus/<pkg> build|test`.
- Never `git add -A`; never commit `dist/`, `.env`, `registry/ratings.json`, `packages/sandbox/runtime/`, `packages/sandbox/build/`, `packages/sandbox-vm-native/prebuilds/`.
- `docs/superpowers/` is gitignored → spec/plan commits need `git add -f`. Source/doc changes under `packages/`, `apps/`, `docs/` (non-superpowers) use plain `git add`.
- Commit message format `<type>(<scope>): <summary>` + trailer `Co-Authored-By: Claude Sonnet 4.6 <noreply@anthropic.com>`.
- **Fail-closed is the security invariant.** No host fallback. `defaultBackend:'docker'` + `minIsolationLevel:'full'` only for this effort; OS/VM backends stay out of scope.
- **Bootstrap is read-only, root-owned, uid-65534-inaccessible-for-write.** It only routes traffic to the proxy; the egress proxy's host grant still decides what is allowed. Never add a channel that lets a skill bypass host grants.
- **Raw adapter output NEVER crosses the telemetry bus.** Validators are injected async callbacks that return `{ok:boolean, reason?:string}` only.
- **Two legs are independent smokes.** Do NOT converge CLI and gateway orchestration (rerank model, `Executor.router`, `maxRetries`). CLI gets NO new telemetry.
- Changesets: `feat(sandbox)`, `feat(gateway)`, `feat(core)` per package actually touched (run `pnpm changeset` before each affected package's commit).
- **Guest runtime uid is 65534** (`--user 65534:65534` in docker-backend). The runtime image `USER 65532:65532` is wrong for this backend — the boot path must be readable (not writable) by 65534, so unify on 65534.
- **Node v22 + undici:** `node:undici` is NOT a builtin module in v22; `process.getBuiltinModule('undici')` returns undefined. The vendored `undici` must set the dispatcher by direct assignment to `globalThis[Symbol.for('undici.globalDispatcher.1')]` — `setGlobalDispatcher()` from the vendored copy does NOT affect the built-in fetch.

---

## File Structure

| File | Responsibility | Touched by |
|---|---|---|
| `packages/sandbox/src/schema.ts` | Leaf sandbox config (unchanged); gateway config lives in `packages/core/src/config-types.ts`. | — |
| `packages/core/src/config-types.ts` | `GatewayConfigSchema` (:25) gains `debugEndpoints: {enabled, includeQuery, bufferSize}`. | T3.1 |
| `packages/core/src/execution-context.ts` (NEW) | `ExecutionContext` interface (traceId/executionId/apiKeyId) + `TelemetrySink` interface + event payload types. | T3.2 |
| `packages/core/src/sandbox-runner.ts` | Accept optional `ExecutionContext` + sink; emit `sandbox.completed` on run() completion + spawn() created + spawn().close()/resultMeta with final downgraded meta. | T3.3 |
| `packages/core/src/executor.ts` | Accept optional `ExecutionContext` + sink + injected `OutputValidator`; emit `adapter.completed` (adapterSuccess/errorCode/outputValidated) + `request.completed`/`request.failed` at outermost. | T3.4 |
| `packages/core/src/router.ts` | Accept optional `ExecutionContext` + sink; emit `routing.completed` with intent/intentSource/intentExtractionSucceeded/candidates/scores/selectionMethod/selectedCandidateRank. | T3.5 |
| `packages/core/src/output-validator.ts` (NEW) | `OutputValidator` type + `runOutputValidator` async timeout wrapper. | T3.4 |
| `packages/gateway/src/debug-telemetry.ts` (NEW) | Ring buffer + aggregator keyed by traceId; merges events by executionId; one-directional status lifecycle; query by runId. | T3.6 |
| `packages/gateway/src/agent-protocol.ts` | `/ask` extracts `oct-e2e-<uuid>` correlation key pre-routing, strips `[trace:...]`, builds ExecutionContext, emits request terminal event; new `GET /agent/debug/last-run` admin-only endpoint. | T3.7 |
| `packages/sandbox/images/runtime/Dockerfile` | COPY bootstrap.cjs + vendored undici into read-only `/opt/octopus-boot/`. | T1.2 |
| `packages/sandbox/images/runtime/bootstrap.cjs` (NEW) | Read HTTPS_PROXY/HTTP_PROXY, prime fetch, install vendored ProxyAgent on the shared dispatcher Symbol. | T1.1 |
| `packages/sandbox/scripts/build-security-images.mjs` | Vendor undici (pinned + SHA-256), stage bootstrap into build context. | T1.3 |
| `packages/sandbox/images/images.lock.json` | Add `undiciVersion` + `undiciSha256` + `undiciTarball`. | T1.3 |
| `packages/sandbox/src/docker/docker-backend.ts` | Inject `NODE_OPTIONS=--require /opt/octopus-boot/bootstrap.cjs` (after spec.env, last-wins). | T1.4 |
| `packages/sandbox/tests/security/image-contract.test.ts` | Update: allow `/opt/octopus-boot/`; new contract assertions (read-only, root-owned, uid-65534 not writable, NODE_OPTIONS, undici hash); new networking behavior tests. | T1.5 |
| `apps/cli/skills/weather/SKILL.md` | `requires.bins [curl]→[node]`, add `sandbox.hosts: [wttr.in]`. | T2.1 |
| `apps/cli/skills/ip-lookup/SKILL.md` | `requires.bins [curl]→[node]`, add `sandbox.hosts: [ip-api.com]`. | T2.2 |
| `apps/cli/src/doctor.ts` (NEW) + `apps/cli/src/index.ts` | `octopus doctor` subcommand reporting sandbox-execution readiness. | T0.1 |
| `~/.claude/skills/hermes-e2e-test/{SKILL.md,run.mjs}` (machine-only, NOT in repo) | Orchestrator: preflight → octopus-wrapper forensics (Hermes leg) → telemetry leg (POST /ask) → poll debug endpoint → 5-stage assert. | T4.1 |
| `docs/integrations/hermes.md` | Correct the fictional `"tools":[{endpoint}]` JSON → real CLI-skill form. | T4.2 |
| `docs/core-concepts/sandbox.md` | Document bootstrap egress mechanism + skill networking prerequisites. | T1.6 |
| `docs/api-reference/agent-protocol.md` | Document `/agent/debug/last-run`, correlation-key extraction, layered telemetry events. | T3.8 |
| `CLAUDE.md` | Update gateway/core/sandbox/image sections. | T3.8 |
| `TEST_INSTRUCTIONS.md` | Add test rows. | T3.8, T4.2 |

---

## Phase 0 — Sandbox-Executable Prerequisites

### Task 0.1: `octopus doctor` sandbox-readiness subcommand

**Files:**
- Create: `apps/cli/src/doctor.ts`
- Modify: `apps/cli/src/index.ts` (register the `doctor` command, near `.command('list')` ~line 239)
- Test: manual (no repo unit test for CLI wiring; behavior verified by running the built CLI)

**Interfaces:**
- Consumes: `getConfig()` (from `@agentoctopus/core`), `loadApiKeys` not needed. Reads `~/.agentoctopus/skills/<name>` via `lookupInstallationId` (from `@agentoctopus/skills`).
- Produces: `runDoctor(): Promise<{ok: boolean; report: DoctorCheck[]}>` where `DoctorCheck = {name: string; ok: boolean; detail: string}`. The CLI prints one line per check and exits non-zero if any `!ok`.

Checks (each independently reportable):
1. `sandbox.runtimeProfiles.node` exists and `bins` includes `node`.
2. `sandbox.docker.image` is set and matches `IMMUTABLE_IMAGE_RE`.
3. `sandbox.proxy.artifact` is set and matches `IMMUTABLE_IMAGE_RE`.
4. `sandbox.defaultBackend === 'docker'` and `sandbox.minIsolationLevel === 'full'`.
5. weather skill at `~/.agentoctopus/skills/weather` has an `installationId` (via `lookupInstallationId`, catch throw → not installed).

- [ ] **Step 1: Write the doctor module**

`apps/cli/src/doctor.ts`:

```ts
import path from 'node:path';
import os from 'node:os';
import { getConfig } from '@agentoctopus/core';
import { lookupInstallationId } from '@agentoctopus/skills';
import { IMMUTABLE_IMAGE_RE } from '@agentoctopus/sandbox';

export interface DoctorCheck { name: string; ok: boolean; detail: string; }
export interface DoctorReport { ok: boolean; report: DoctorCheck[]; }

export async function runDoctor(): Promise<DoctorReport> {
  const cfg = getConfig();
  const checks: DoctorCheck[] = [];

  const nodeProfile = cfg.sandbox.runtimeProfiles?.['node'];
  checks.push({
    name: 'runtimeProfiles.node covers node bin',
    ok: !!nodeProfile && Array.isArray(nodeProfile.bins) && nodeProfile.bins.includes('node'),
    detail: nodeProfile ? `bins=[${(nodeProfile.bins ?? []).join(', ')}]` : 'sandbox.runtimeProfiles.node missing',
  });

  const dockerImage = cfg.sandbox.docker?.image ?? '';
  checks.push({
    name: 'sandbox.docker.image immutable',
    ok: IMMUTABLE_IMAGE_RE.test(dockerImage),
    detail: dockerImage || 'sandbox.docker.image unset',
  });

  const proxyArtifact = cfg.sandbox.proxy?.artifact ?? '';
  checks.push({
    name: 'sandbox.proxy.artifact immutable',
    ok: IMMUTABLE_IMAGE_RE.test(proxyArtifact),
    detail: proxyArtifact || 'sandbox.proxy.artifact unset',
  });

  checks.push({
    name: 'backend fail-closed (docker + full)',
    ok: cfg.sandbox.defaultBackend === 'docker' && cfg.sandbox.minIsolationLevel === 'full',
    detail: `defaultBackend=${cfg.sandbox.defaultBackend} minIsolationLevel=${cfg.sandbox.minIsolationLevel}`,
  });

  const weatherDir = path.join(os.homedir(), '.agentoctopus', 'skills', 'weather');
  let installOk = false;
  let installDetail = 'not installed (~/.agentoctopus/skills/weather)';
  try {
    installOk = !!lookupInstallationId(weatherDir);
    installDetail = installOk ? 'installationId present' : 'no installationId';
  } catch (err) {
    installDetail = `missing installationId: ${(err as Error).message}`;
  }
  checks.push({ name: 'weather skill installed with installationId', ok: installOk, detail: installDetail });

  return { ok: checks.every(c => c.ok), report: checks };
}
```

- [ ] **Step 2: Register the command in the CLI**

In `apps/cli/src/index.ts`, add (near the `list` command, ~line 239):

```ts
program
  .command('doctor')
  .description('Check whether skills can execute in the sandbox (runtime profiles, images, installationId)')
  .action(async () => {
    const { runDoctor } = await import('./doctor.js');
    const { ok, report } = await runDoctor();
    console.log(chalk.bold('\n🐙 Sandbox readiness\n'));
    for (const c of report) {
      const mark = c.ok ? chalk.green('✔') : chalk.red('✘');
      console.log(`${mark} ${c.name} ${chalk.gray('— ' + c.detail)}`);
    }
    if (!ok) {
      console.log(chalk.yellow('\nSee docs/core-concepts/sandbox.md to fix the failing checks.\n'));
      process.exitCode = 1;
    } else {
      console.log(chalk.green('\nSandbox execution ready.\n'));
    }
  });
```

- [ ] **Step 3: Build the CLI and run doctor**

Run: `pnpm --filter @agentoctopus/cli build && node apps/cli/dist/index.js doctor`
Expected: prints 5 check lines; on a fresh machine several will be ✘ (this is expected — the doctor surfaces what P0 config must fix). Verify it does NOT crash and exits non-zero when checks fail.

- [ ] **Step 4: Commit**

```bash
git add apps/cli/src/doctor.ts apps/cli/src/index.ts
git commit -m "feat(cli): octopus doctor — sandbox-execution readiness checks

Co-Authored-By: Claude Sonnet 4.6 <noreply@anthropic.com>"
```

> **Note (P0 config, not code):** The actual sandbox config (`runtimeProfiles.node`, pinned `docker.image`/`proxy.artifact`, `sandbox.grants`, weather `installationId`) is written to `~/.agentoctopus/octopus.json` by the operator, guided by the doctor output and the pinned digests produced by the P1 image build (`security:images -- --print-env`). This is environment setup, not a repo change. P2 adds the grants once weather has an installationId.

---

## Phase 1 — Docker Sandbox Egress Fix (bootstrap.cjs + vendored undici)

### Task 1.1: bootstrap.cjs — route built-in fetch through the proxy

**Files:**
- Create: `packages/sandbox/images/runtime/bootstrap.cjs`
- Test: `packages/sandbox/tests/security/bootstrap.test.ts` (unit test using a fake proxy + the vendored undici)

**Interfaces:**
- Consumes: `HTTPS_PROXY`/`HTTP_PROXY` env (injected by docker-backend); the vendored undici at `/opt/octopus-boot/undici/`.
- Produces: side-effect only — installs a `ProxyAgent` on `globalThis[Symbol.for('undici.globalDispatcher.1')]` so built-in `fetch` goes through the proxy. Exits silently (never throws) if no proxy is set.

Behavior contract:
1. Read `process.env.HTTPS_PROXY || process.env.HTTP_PROXY`. If empty/absent → return immediately (no proxy env, behavior unchanged).
2. Prime the dispatcher: `await fetch('data:,')` inside try/catch (forces Node to populate the global dispatcher slot). Use a `data:` URL so no network is touched.
3. `require('/opt/octopus-boot/undici/index.js')` → get `ProxyAgent`.
4. `new ProxyAgent(proxyUrl)` and assign to `globalThis[Symbol.for('undici.globalDispatcher.1')]`.
5. Any failure → write a fail-loud line to stderr (`[octopus-boot] ...`) but NEVER rethrow (must not crash the skill). The downstream symptom of a broken bootstrap is `EAI_AGAIN` (guest DNS cut), NOT a leaked direct connection — security stays fail-closed.

- [ ] **Step 1: Write the failing unit test**

`packages/sandbox/tests/security/bootstrap.test.ts`:

```ts
import { describe, it, expect } from 'vitest';
import { spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';

const HERE = dirname(fileURLToPath(import.meta.url));
const BOOTSTRAP = join(HERE, '..', '..', 'images', 'runtime', 'bootstrap.cjs');

// Run a Node child that --require's the bootstrap then fetches, with the proxy
// env pointed at an unroutable address. If the bootstrap works, built-in fetch
// is routed through the (dead) proxy → ECONNREFUSED. If the bootstrap is absent
// or broken, the fetch attempts a direct connection to a made-up host and the
// guest DNS cut yields EAI_AGAIN. We assert the bootstrap changes the failure
// mode from EAI_AGAIN to ECONNREFUSED — proof fetch is now proxy-routed.
function fetchWithBootstrap(env: NodeJS.ProcessEnv): string {
  const script = `
    (async () => {
      try { await fetch('http://nonexistent-oct-e2e.invalid/'); console.log('NOERROR'); }
      catch (e) { console.log(String(e.cause?.code ?? e.code ?? e.message)); }
    })();
  `;
  const r = spawnSync(process.execPath, ['--require', BOOTSTRAP, '-e', script], {
    env: { PATH: process.env.PATH, ...env },
    encoding: 'utf8',
  });
  return (r.stdout || '') + (r.stderr || '');
}

describe('bootstrap.cjs proxy routing', () => {
  it('is a no-op when no proxy env is set (behavior unchanged)', () => {
    const out = fetchWithBootstrap({});
    // No proxy env → bootstrap returns early → fetch does a direct DNS lookup of
    // the .invalid host → EAI_AGAIN (or ENOTFOUND on hosts that resolve it).
    expect(out).toMatch(/EAI_AGAIN|ENOTFOUND/);
    expect(out).not.toContain('[octopus-boot] error');
  });

  it('routes built-in fetch through the proxy when HTTPS_PROXY is set', () => {
    const out = fetchWithBootstrap({ HTTPS_PROXY: 'http://127.0.0.1:1' });
    // Proxy is set but unroutable → fetch now reaches the proxy layer and fails
    // with ECONNREFUSED, NOT the direct-DNS EAI_AGAIN. This is the fixed behavior.
    expect(out).toContain('ECONNREFUSED');
    expect(out).not.toMatch(/EAI_AGAIN|ENOTFOUND/);
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `pnpm --filter @agentoctopus/sandbox exec vitest run tests/security/bootstrap.test.ts`
Expected: FAIL — `BOOTSTRAP` file does not exist (spawnSync error / no ECONNREFUSED).

- [ ] **Step 3: Write the vendored-undici vendor step (prerequisite for the test)**

The bootstrap requires `/opt/octopus-boot/undici/`. For the unit test, vendor undici into a temp location the bootstrap can resolve. The bootstrap resolves undici relative to itself: `require(require('path').join(__dirname, 'undici', 'index.js'))`. Task 1.3 makes the build vendor undici into `images/runtime/undici/`. For the unit test to pass, that directory must exist. Implement the vendoring as a small standalone script first so the test can run it in `beforeAll`, OR vendor it once now:

`packages/sandbox/scripts/vendor-undici.mjs`:

```js
#!/usr/bin/env node
/** Vendor pinned undici into packages/sandbox/images/runtime/undici/ with a
 *  SHA-256 integrity check against images.lock.json (undiciTarball/undiciSha256). */
import { createHash } from 'node:crypto';
import { execFileSync } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const HERE = path.dirname(fileURLToPath(import.meta.url));
const RUNTIME_DIR = path.resolve(HERE, '..', 'images', 'runtime');
const LOCK = JSON.parse(fs.readFileSync(path.resolve(HERE, '..', 'images', 'images.lock.json'), 'utf8'));
const { undiciVersion, undiciTarball, undiciSha256 } = LOCK;
if (!undiciVersion || !undiciTarball || !undiciSha256) {
  console.error('images.lock.json missing undiciVersion/undiciTarball/undiciSha256');
  process.exit(1);
}

const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'oct-undici-'));
try {
  const tgz = path.join(tmp, 'undici.tgz');
  execFileSync('curl', ['-fsSL', undiciTarball, '-o', tgz]);
  const got = createHash('sha256').update(fs.readFileSync(tgz)).digest('hex');
  if (got !== undiciSha256) {
    console.error(`undici tarball sha256 mismatch: got ${got}, want ${undiciSha256}`);
    process.exit(1);
  }
  execFileSync('tar', ['-xzf', tgz, '-C', tmp]);
  const dest = path.join(RUNTIME_DIR, 'undici');
  fs.rmSync(dest, { recursive: true, force: true });
  fs.renameSync(path.join(tmp, 'package'), dest);
  console.log(`vendored undici@${undiciVersion} -> ${dest}`);
} finally {
  fs.rmSync(tmp, { recursive: true, force: true });
}
```

Add to `images.lock.json` (Task 1.3 locks these; do it now so the vendor script runs):

```json
"undiciVersion": "6.24.1",
"undiciTarball": "https://registry.npmjs.org/undici/-/undici-6.24.1.tgz",
"undiciSha256": "<COMPUTE — run: curl -fsSL https://registry.npmjs.org/undici/-/undici-6.24.1.tgz | shasum -a 256>"
```

> Compute the real sha256 with `curl -fsSL https://registry.npmjs.org/undici/-/undici-6.24.1.tgz | shasum -a 256 | awk '{print $1}'` and fill it in. Do NOT guess.

Run the vendor script once so the unit test can resolve undici:
`node packages/sandbox/scripts/vendor-undici.mjs`

- [ ] **Step 4: Write the bootstrap implementation**

`packages/sandbox/images/runtime/bootstrap.cjs`:

```js
'use strict';
/* octopus-boot — route built-in Node fetch (undici) through the egress proxy.
 *
 * Loaded via NODE_OPTIONS=--require /opt/octopus-boot/bootstrap.cjs inside the
 * distroless runtime image. Built-in fetch in Node v22 does NOT honor
 * HTTP(S)_PROXY, and `node:undici`/`setGlobalDispatcher` from a vendored copy
 * do NOT affect the built-in dispatcher. The only reliable hook is assigning a
 * vendored undici ProxyAgent directly to the shared global dispatcher Symbol.
 *
 * Fail-loud to stderr but NEVER throw: a broken bootstrap must not crash the
 * skill. The failure mode stays fail-closed (guest DNS is cut → EAI_AGAIN), it
 * never opens a direct path to the internet. */
try {
  const proxy = process.env.HTTPS_PROXY || process.env.HTTP_PROXY;
  if (!proxy) {
    // No proxy env → leave the default dispatcher untouched (unchanged behavior).
    return;
  }

  const path = require('node:path');
  const { ProxyAgent } = require(path.join(__dirname, 'undici', 'index.js'));

  // Prime the global dispatcher so Node populates the shared slot before we
  // overwrite it. Use a data: URL so no network is touched. Awaited BEFORE any
  // assignment, so the first real fetch can never race a half-installed
  // dispatcher.
  const KEY = Symbol.for('undici.globalDispatcher.1');
  (async () => {
    try {
      await fetch('data:,');
    } catch { /* ignore — priming best-effort */ }
    try {
      globalThis[KEY] = new ProxyAgent(proxy);
    } catch (err) {
      process.stderr.write(`[octopus-boot] failed to install ProxyAgent: ${(err && err.message) || err}\n`);
    }
  })();
} catch (err) {
  process.stderr.write(`[octopus-boot] bootstrap error: ${(err && err.message) || err}\n`);
}
```

> **CJS note:** `bootstrap.cjs` is CommonJS (`require`), loaded by `--require` before the ESM skill runs. Top-level `return` is legal in a CJS module wrapper. The async IIFE assigns the ProxyAgent only AFTER the awaited prime, so a skill's very first real `fetch()` is serialized behind dispatcher installation — there is no window where a fetch runs against the un-proxied default dispatcher.

- [ ] **Step 5: Run the unit test to verify it passes**

Run: `pnpm --filter @agentoctopus/sandbox exec vitest run tests/security/bootstrap.test.ts`
Expected: PASS — first case EAI_AGAIN/ENOTFOUND (no proxy), second case ECONNREFUSED (proxied).

> If the second case still yields EAI_AGAIN, the priming/Symbol mechanism is off. Verify Node version (`node --version` ≥ 22) and that `images/runtime/undici/index.js` exists and exports `ProxyAgent`.

- [ ] **Step 6: Commit**

```bash
git add packages/sandbox/images/runtime/bootstrap.cjs packages/sandbox/scripts/vendor-undici.mjs packages/sandbox/tests/security/bootstrap.test.ts packages/sandbox/images/images.lock.json
# NOTE: packages/sandbox/images/runtime/undici/ is a build artifact — add it to .gitignore, do NOT commit it.
git commit -m "feat(sandbox): bootstrap.cjs routes built-in fetch through egress proxy

Co-Authored-By: Claude Sonnet 4.6 <noreply@anthropic.com>"
```

> Add `packages/sandbox/images/runtime/undici/` to `.gitignore` in the same commit (vendored artifact, reproducible via vendor-undici.mjs).

### Task 1.2: runtime Dockerfile — COPY boot path read-only

**Files:**
- Modify: `packages/sandbox/images/runtime/Dockerfile`
- Modify: `packages/sandbox/scripts/build-security-images.mjs` (`renderRuntimeDockerfile`)

**Interfaces:**
- Consumes: `bootstrap.cjs` + `undici/` staged into the build context (Task 1.3 stages them).
- Produces: image layer `/opt/octopus-boot/` containing `bootstrap.cjs` + `undici/`, root-owned, mode 0555 dirs / 0444 files (read-only, NOT writable by uid 65534).

- [ ] **Step 1: Update `renderRuntimeDockerfile` in build-security-images.mjs**

Replace the `renderRuntimeDockerfile` function body:

```js
function renderRuntimeDockerfile(nodeBase, distrolessBase) {
  return `# Rendered by build-security-images.mjs from images.lock.json — do not edit refs by hand.
FROM ${nodeBase} AS node-source
FROM ${distrolessBase}
COPY --from=node-source /usr/local/bin/node /usr/local/bin/node
# octopus-boot: read-only, root-owned bootstrap + vendored undici. Mode 0555/0444
# so the runtime uid (65534) can read but never write. Build context stages
# bootstrap.cjs and undici/ under octopus-boot/.
COPY --chmod=0555 octopus-boot/ /opt/octopus-boot/
USER 65534:65534
WORKDIR /skill
ENV NODE_ENV=production PATH=/usr/local/bin
# Deliberately NO ENTRYPOINT and NO CMD: DockerBackend appends ExecSpec.command verbatim.
`;
}
```

> **uid change:** `USER 65532:65532` → `USER 65534:65534` to match docker-backend's `--user 65534:65534`. This makes the image's declared user consistent with the backend's enforced user; the boot path is readable by 65534 (0555/0444, root-owned) but not writable.

- [ ] **Step 2: Mirror the change in the source Dockerfile**

`packages/sandbox/images/runtime/Dockerfile` — update to match (comments + `USER 65534:65534` + the `COPY --chmod=0555 octopus-boot/ /opt/octopus-boot/` line). Keep the header comment; note the boot path is staged by the build script.

- [ ] **Step 3: Stage bootstrap + undici into the runtime build context**

In `build-security-images.mjs` `main()`, after writing `rtDockerfile` and before `dockerBuild`, stage the boot files:

```js
    // Stage octopus-boot (bootstrap.cjs + vendored undici) into the runtime context.
    const bootDir = path.join(rtDir, 'octopus-boot');
    await fs.mkdir(bootDir, { recursive: true });
    await fs.copyFile(
      path.join(PKG_ROOT, 'images', 'runtime', 'bootstrap.cjs'),
      path.join(bootDir, 'bootstrap.cjs'),
    );
    // Vendor undici (pinned + sha256-checked) then copy it in.
    await execFileAsync(process.execPath, [path.join(PKG_ROOT, 'scripts', 'vendor-undici.mjs')]);
    await fs.cp(
      path.join(PKG_ROOT, 'images', 'runtime', 'undici'),
      path.join(bootDir, 'undici'),
      { recursive: true },
    );
```

Add `const execFileAsync2 = execFileAsync;` not needed — reuse `execFileAsync`. Ensure `fs.cp` is available (Node ≥ 16.7; fine on v22).

- [ ] **Step 4: Build the runtime image and verify the boot layer**

Run: `pnpm --filter @agentoctopus/sandbox build && node packages/sandbox/scripts/build-security-images.mjs --print-env`
Then: `docker run --rm agentoctopus/skill-runtime:test node -e "const fs=require('fs');console.log(fs.readdirSync('/opt/octopus-boot'));const s=fs.statSync('/opt/octopus-boot/bootstrap.cjs');console.log('mode',(s.mode&0o777).toString(8),'uid',s.uid)"`
Expected: `[ 'bootstrap.cjs', 'undici' ]`, mode `555` (or `444`), uid `0` (root-owned).

- [ ] **Step 5: Commit**

```bash
git add packages/sandbox/images/runtime/Dockerfile packages/sandbox/scripts/build-security-images.mjs
git commit -m "feat(sandbox): runtime image ships read-only /opt/octopus-boot, uid 65534

Co-Authored-By: Claude Sonnet 4.6 <noreply@anthropic.com>"
```

### Task 1.3: lock undici in images.lock.json

**Files:**
- Modify: `packages/sandbox/images/images.lock.json`
- Modify: `packages/sandbox/tests/security/image-contract.test.ts` (lock-shape assertion)

**Interfaces:**
- Consumes: the new `undiciVersion/undiciTarball/undiciSha256` fields.
- Produces: lock entries that vendor-undici.mjs and the contract test both read.

- [ ] **Step 1: Add the fields (real sha256, computed in Task 1.1 Step 3)**

`images.lock.json` gains:

```json
"undiciVersion": "6.24.1",
"undiciTarball": "https://registry.npmjs.org/undici/-/undici-6.24.1.tgz",
"undiciSha256": "<64 lowercase hex>",
```

- [ ] **Step 2: Assert the lock shape in the contract test**

Add to `image-contract.test.ts` (a new `it`):

```ts
  it('lock pins undici version + sha256 for the vendored egress dependency', () => {
    expect(lock.undiciVersion).toMatch(/^\d+\.\d+\.\d+$/);
    expect(lock.undiciTarball).toMatch(/^https:\/\/registry\.npmjs\.org\/undici\/-\/undici-.*\.tgz$/);
    expect(lock.undiciSha256).toMatch(/^[0-9a-f]{64}$/);
  });
```

- [ ] **Step 3: Run the lock assertion**

Run: `pnpm --filter @agentoctopus/sandbox exec vitest run tests/security/image-contract.test.ts -t "undici"`
Expected: PASS.

- [ ] **Step 4: Commit**

```bash
git add packages/sandbox/images/images.lock.json packages/sandbox/tests/security/image-contract.test.ts
git commit -m "feat(sandbox): pin vendored undici version + sha256 in images.lock.json

Co-Authored-By: Claude Sonnet 4.6 <noreply@anthropic.com>"
```

### Task 1.4: docker-backend injects NODE_OPTIONS

**Files:**
- Modify: `packages/sandbox/src/docker/docker-backend.ts:48-54` (`buildDockerArgs` trusted env block)
- Test: `packages/sandbox/tests/security/docker-backend-args.test.ts` (or add to an existing backend-args unit test if present — search first)

**Interfaces:**
- Consumes: the canonical guest boot path `/opt/octopus-boot/bootstrap.cjs`.
- Produces: `buildDockerArgs` output includes `-e NODE_OPTIONS=--require /opt/octopus-boot/bootstrap.cjs` placed AFTER `spec.env` so Docker last-wins and a skill cannot override it.

- [ ] **Step 1: Write the failing unit test**

Search for an existing args test: `grep -rln "buildDockerArgs" packages/sandbox/tests`. If none, create `packages/sandbox/tests/security/docker-backend-args.test.ts`:

```ts
import { describe, it, expect } from 'vitest';
import { buildDockerArgs } from '../../src/docker/docker-backend.js';

const basePrepare = {
  runtimeProfile: { dockerImage: 'agentoctopus/skill-runtime@sha256:' + 'a'.repeat(64) },
  resources: { memoryBytes: 512 * 1024 * 1024, timeoutMs: 30_000, cpus: 0.5 },
  snapshotRoot: '/store/sha256:' + 'b'.repeat(64),
  expectedSnapshotDigest: 'sha256:' + 'b'.repeat(64),
  proxyAddr: 'http://egress-proxy:8080',
  caBundlePath: '/tmp/ca.pem',
  guestSkillRoot: '/skill',
  guestCaBundlePath: '/etc/skill-ca/ca.pem',
  hosts: [],
  credentials: [],
  denied: { hosts: [], credentials: [] },
};

describe('buildDockerArgs trusted env', () => {
  it('injects NODE_OPTIONS bootstrap AFTER spec.env so a skill cannot override it', () => {
    const args = buildDockerArgs({
      config: { docker: { image: basePrepare.runtimeProfile.dockerImage, memory: '512m', cpus: '0.5', pids: 64, ulimits: { nofile: 256, fsize: '32m' } } },
      prepare: basePrepare as never,
      spec: { command: ['node', '/skill/scripts/invoke.js'], cwd: '/skill', env: { NODE_OPTIONS: '--evil', OCTOPUS_INPUT: '{}' }, timeoutMs: 30_000 },
      networkName: 'oct-internal',
      containerName: 'oct-runtime',
    });
    // findIndex on the VALUE array element (each '-e' flag is followed by its
    // 'K=V' value) — predicate runs on the value, so check args[i-1]==='-e'.
    // We scan ALL '-e NODE_OPTIONS=' occurrences and take the LAST one (Docker
    // last-wins; the trusted injection is appended after the spec.env one).
    const nodeOptionsIdxs = args
      .map((a, i) => (args[i - 1] === '-e' && a.startsWith('NODE_OPTIONS=') ? i : -1))
      .filter(i => i >= 0);
    const specEnvIdx = args.findIndex((a, i) => args[i - 1] === '-e' && a === 'NODE_OPTIONS=--evil');
    expect(nodeOptionsIdxs.length).toBeGreaterThan(0);
    const lastIdx = nodeOptionsIdxs[nodeOptionsIdxs.length - 1];
    expect(args[lastIdx]).toBe('NODE_OPTIONS=--require /opt/octopus-boot/bootstrap.cjs');
    // The trusted injection must come after every spec.env -e entry (Docker last-wins on collision).
    expect(specEnvIdx).toBeGreaterThan(-1);
    expect(lastIdx).toBeGreaterThan(specEnvIdx);
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `pnpm --filter @agentoctopus/sandbox exec vitest run tests/security/docker-backend-args.test.ts`
Expected: FAIL — no `NODE_OPTIONS=--require …` line present (only the malicious spec.env one).

- [ ] **Step 3: Implement the injection**

In `buildDockerArgs` (docker-backend.ts:48-54), after the `SSL_CERT_FILE`/`NODE_EXTRA_CA_CERTS`/`REQUESTS_CA_BUNDLE` pushes, add:

```ts
  // Route built-in Node fetch through the egress proxy (P1): the distroless
  // guest's fetch ignores HTTP(S)_PROXY, so force-load the read-only bootstrap
  // via NODE_OPTIONS. Placed AFTER spec.env so Docker last-wins — a skill cannot
  // override it (and OCTOPUS_INPUT/env-hygiene already rejects caller NODE_OPTIONS,
  // but defense-in-depth: trusted env always appended last).
  args.push('-e', `NODE_OPTIONS=--require /opt/octopus-boot/bootstrap.cjs`);
```

- [ ] **Step 4: Run test to verify it passes**

Run: `pnpm --filter @agentoctopus/sandbox exec vitest run tests/security/docker-backend-args.test.ts`
Expected: PASS.

- [ ] **Step 5: Commit**

```bash
git add packages/sandbox/src/docker/docker-backend.ts packages/sandbox/tests/security/docker-backend-args.test.ts
git commit -m "feat(sandbox): docker backend injects NODE_OPTIONS bootstrap (trusted env, last-wins)

Co-Authored-By: Claude Sonnet 4.6 <noreply@anthropic.com>"
```

### Task 1.5: image-contract updates + networking behavior tests

**Files:**
- Modify: `packages/sandbox/tests/security/image-contract.test.ts`
- Create: `packages/sandbox/tests/security/egress-networking.test.ts` (Docker-lane, probeDockerImages-gated)

**Interfaces:**
- Consumes: the built runtime image (`OCTOPUS_TEST_RUNTIME_IMAGE`), the proxy image, a SessionCa, and a real egress proxy sidecar for the networking test.
- Produces: contract assertions for the boot path + behavior proof that granted hosts route and ungranted hosts 403, with no `EAI_AGAIN`.

- [ ] **Step 1: Update the forbidden-tools contract to allow the boot path**

In `image-contract.test.ts`, the `it.each` forbidden-tools list and the filesystem-scan probe currently scan `/bin /sbin /usr/bin /usr/sbin /usr/local/bin`. `/opt/octopus-boot/` is outside those dirs, so no change is needed to the existing scan. Add a NEW `it` asserting the boot path is present, root-owned, read-only, and that NODE_OPTIONS points at it:

```ts
  it('runtime ships a read-only root-owned /opt/octopus-boot bootstrap', async (ctx) => {
    if (!dockerAvailable) return ctx.skip();
    const probe = [
      'const fs=require("fs");',
      'const out={};',
      'out.boot=fs.readdirSync("/opt/octopus-boot");',
      'const bs=fs.statSync("/opt/octopus-boot/bootstrap.cjs");',
      'out.mode=(bs.mode&0o777).toString(8);out.uid=bs.uid;out.gid=bs.gid;',
      'out.undici=fs.existsSync("/opt/octopus-boot/undici/index.js");',
      // Writable by uid 65534? Attempt to open for write must fail (read-only fs + 0555/0444).
      'try{fs.writeFileSync("/opt/octopus-boot/_w","x");out.writable=true}catch{out.writable=false}',
      'console.log(JSON.stringify(out));',
    ].join('');
    const out = await dockerRun(runtimeImage, ['node', '-e', probe]);
    expect(out.exitCode).toBe(0);
    const r = JSON.parse(out.stdout.trim());
    expect(r.boot).toContain('bootstrap.cjs');
    expect(r.undici).toBe(true);
    expect(r.uid).toBe(0);           // root-owned
    expect(r.writable).toBe(false);  // not writable by the runtime uid (65534)
  }, DOCKER_TIMEOUT);
```

- [ ] **Step 2: Run the contract test to verify it passes**

Run: rebuild the image first (`node packages/sandbox/scripts/build-security-images.mjs`), then `pnpm --filter @agentoctopus/sandbox exec vitest run tests/security/image-contract.test.ts -t "octopus-boot"`
Expected: PASS.

- [ ] **Step 3: Write the networking behavior test**

`packages/sandbox/tests/security/egress-networking.test.ts`:

```ts
import { describe, it, expect, beforeAll } from 'vitest';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { probeDockerImages } from './harness.js';

const execFileAsync = promisify(execFile);
const runtimeImage = process.env.OCTOPUS_TEST_RUNTIME_IMAGE ?? 'agentoctopus/skill-runtime:test';
const proxyImage = process.env.OCTOPUS_TEST_PROXY_IMAGE ?? 'agentoctopus/egress-proxy:test';
const DOCKER_TIMEOUT = 120_000;

let available = false;
beforeAll(async () => {
  available = (await probeDockerImages([runtimeImage, proxyImage])).available;
});

// This test stands up the real internal+egress network topology with the proxy
// sidecar, then runs the runtime guest (with NODE_OPTIONS bootstrap) fetching a
// granted host and an ungranted host. Asserting the distinction proves both
// that the bootstrap routes fetch to the proxy AND that the proxy's host grant
// still gates egress (fail-closed preserved). The full sidecar harness is
// shared with the egress-proxy security matrix; this is the behavior contract.
describe('docker egress networking (bootstrap routes fetch; grant gates egress)', () => {
  it.todo('granted host routes through proxy and returns data (no EAI_AGAIN)');
  it.todo('ungranted host is rejected at the egress layer with 403 host not granted');
});
```

> **Implementation note for the implementer:** the full topology test reuses the egress-proxy security-matrix harness (`tests/security/harness.ts` and the existing egress test that boots the proxy sidecar + internal network). Wire the runtime guest with `--network <internal>`, `-e HTTPS_PROXY=http://egress-proxy:8080`, `-e NODE_OPTIONS=--require /opt/octopus-boot/bootstrap.cjs`, run `node /skill/scripts/invoke.js`-equivalent fetch, assert: (granted) real data + no `EAI_AGAIN`; (ungranted) proxy 403 containing `host not granted`. If building the full live topology in this lane is too heavy for the unit run, implement it as a probeDockerImages-gated integration test that is exercised in the docker security lane (hosted-docker-proxy), matching how the existing egress matrix is gated. The `it.todo` placeholders are the contract — the implementer replaces them with the real assertions.

- [ ] **Step 4: Commit**

```bash
git add packages/sandbox/tests/security/image-contract.test.ts packages/sandbox/tests/security/egress-networking.test.ts
git commit -m "test(sandbox): contract for read-only boot path + egress networking behavior

Co-Authored-By: Claude Sonnet 4.6 <noreply@anthropic.com>"
```

### Task 1.6: sandbox.md — document the egress mechanism

**Files:**
- Modify: `docs/core-concepts/sandbox.md`

- [ ] **Step 1: Add a "Skill networking (egress)" section**

Document: distroless runtime; built-in fetch ignores HTTP(S)_PROXY; bootstrap.cjs via NODE_OPTIONS routes fetch through the egress proxy using vendored undici; the proxy's host grant still decides what's allowed (fail-closed); a skill needs `sandbox.hosts` + a matching `sandbox.grants` entry; boot path is read-only/root-owned.

- [ ] **Step 2: Commit**

```bash
git add docs/core-concepts/sandbox.md
git commit -m "docs(sandbox): document bootstrap egress mechanism + skill networking prerequisites

Co-Authored-By: Claude Sonnet 4.6 <noreply@anthropic.com>"
```

---

## Phase 2 — Skill Manifest Fixes

### Task 2.1: weather skill — bins + hosts

**Files:**
- Modify: `apps/cli/skills/weather/SKILL.md`
- Test: `pnpm --filter @agentoctopus/skills test` (schema validation) + manual doctor re-check

**Interfaces:**
- Consumes: `SandboxRequestSchema` (`sandbox.hosts`), `requires.bins`.
- Produces: SKILL.md frontmatter with `requires.bins: [node]` and `sandbox: { hosts: [wttr.in] }`.

- [ ] **Step 1: Update the frontmatter**

```yaml
---
name: weather
description: >
  Get current weather conditions and forecast for any city or location.
  Use when the user asks about weather, temperature, rain, forecast,
  or conditions in a place — e.g. "What's the weather in Tokyo?".
tags: [weather, forecast, temperature, climate]
version: "1.0.1"
requires:
  bins: [node]
sandbox:
  hosts: [wttr.in]
---
```

> **Why `[node]`:** the skill's `invoke.js` uses Node `fetch`, and the distroless runtime ships only `node`. `requestedBins()` reads the top-level `requires:` block via `getSkillEntry(...).metadata.requires.bins`, so `[curl]` would fail `resolveRuntimeProfile` (the `[node]` profile can't cover `curl`). `sandbox.hosts: [wttr.in]` is belt-and-suspenders — `requestedHosts()` already extracts `wttr.in` from the `https://wttr.in/...` URL in the body, but explicit declaration is the reviewed contract.

- [ ] **Step 2: Validate schema + run skills tests**

Run: `pnpm --filter @agentoctopus/skills build && pnpm --filter @agentoctopus/skills test`
Expected: PASS (frontmatter parses against `SandboxRequestSchema`).

- [ ] **Step 3: Commit**

```bash
git add apps/cli/skills/weather/SKILL.md
git commit -m "fix(cli): weather skill requires.bins [curl]→[node] + sandbox.hosts wttr.in

Co-Authored-By: Claude Sonnet 4.6 <noreply@anthropic.com>"
```

### Task 2.2: ip-lookup skill — bins + hosts

**Files:**
- Modify: `apps/cli/skills/ip-lookup/SKILL.md`

- [ ] **Step 1: Update the frontmatter**

```yaml
---
name: ip-lookup
description: >
  Look up geolocation and network details for a specific IP address or domain name.
  ONLY use this when the user provides an actual IP address (e.g. 8.8.8.8, 1.1.1.1)
  or a domain name (e.g. github.com) to look up. Do NOT use for general questions
  about what ISP, AS, or networking terms mean.
tags: [ip, geolocation, network, lookup, dns]
version: "1.0.1"
requires:
  bins: [node]
sandbox:
  hosts: [ip-api.com]
---
```

- [ ] **Step 2: Validate**

Run: `pnpm --filter @agentoctopus/skills test`
Expected: PASS.

- [ ] **Step 3: Commit**

```bash
git add apps/cli/skills/ip-lookup/SKILL.md
git commit -m "fix(cli): ip-lookup skill requires.bins [curl]→[node] + sandbox.hosts ip-api.com

Co-Authored-By: Claude Sonnet 4.6 <noreply@anthropic.com>"
```

> **Note (P2 config, not code):** the matching `sandbox.grants` entries (`installationId + digest → hosts`) are written to `~/.agentoctopus/octopus.json` by the operator after the weather/ip-lookup skills are installed (have `installationId`) and the snapshot digest is known. The doctor (Task 0.1) reports readiness; the grants themselves are environment config.

---

## Phase 3 — ExecutionContext + Layered Telemetry + Debug Endpoint

### Task 3.1: `gateway.debugEndpoints` object config

**Files:**
- Modify: `packages/core/src/config-types.ts:25-30` (`GatewayConfigSchema`)
- Test: `packages/core/tests/config-types.test.ts` (search for existing; create if absent)

**Interfaces:**
- Produces: `GatewayConfigSchema` gains `debugEndpoints: z.object({enabled: z.boolean().default(false), includeQuery: z.boolean().default(false), bufferSize: z.number().int().positive().default(10)}).prefault({})`.

- [ ] **Step 1: Write the failing test**

```ts
import { describe, it, expect } from 'vitest';
import { GatewayConfigSchema } from '../src/config-types.js';

describe('GatewayConfigSchema.debugEndpoints', () => {
  it('defaults to disabled with includeQuery false and bufferSize 10', () => {
    const c = GatewayConfigSchema.parse({});
    expect(c.debugEndpoints).toEqual({ enabled: false, includeQuery: false, bufferSize: 10 });
  });
  it('accepts an explicit object', () => {
    const c = GatewayConfigSchema.parse({ debugEndpoints: { enabled: true, includeQuery: true, bufferSize: 25 } });
    expect(c.debugEndpoints).toEqual({ enabled: true, includeQuery: true, bufferSize: 25 });
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `pnpm --filter @agentoctopus/core exec vitest run tests/config-types.test.ts -t debugEndpoints`
Expected: FAIL — `debugEndpoints` undefined.

- [ ] **Step 3: Implement**

Add to `GatewayConfigSchema`:

```ts
  debugEndpoints: z
    .object({
      enabled: z.boolean().default(false),
      includeQuery: z.boolean().default(false),
      bufferSize: z.number().int().positive().default(10),
    })
    .prefault({}),
```

- [ ] **Step 4: Run test to verify it passes**

Run: same as Step 2. Expected: PASS.

- [ ] **Step 5: Commit**

```bash
git add packages/core/src/config-types.ts packages/core/tests/config-types.test.ts
git commit -m "feat(core): gateway.debugEndpoints object config (enabled/includeQuery/bufferSize)

Co-Authored-By: Claude Sonnet 4.6 <noreply@anthropic.com>"
```

### Task 3.2: ExecutionContext + TelemetrySink types

**Files:**
- Create: `packages/core/src/execution-context.ts`
- Modify: `packages/core/src/index.ts` (export)
- Test: `packages/core/tests/execution-context.test.ts`

**Interfaces:**
- Produces (consumed by T3.3/3.4/3.5 and gateway T3.6/3.7):

```ts
import type { SandboxResultMeta, BackendKind, IsolationLevel } from '@agentoctopus/sandbox';

/** Per-request telemetry carrier threaded through Router/Executor/SandboxRunner.
 *  Does NOT change AdapterResult/ExecutionResult shapes. All fields optional so
 *  CLI (no telemetry) can omit the context entirely. */
export interface ExecutionContext {
  traceId?: string;        // correlation key (oct-e2e-<uuid>) extracted by gateway /ask
  executionId?: string;    // stable per logical execution (one run() or one spawn() session)
  apiKeyId?: string;       // caller identity (hashed key id), never the raw key
  receivedAt?: number;     // request start (ms epoch)
}

export interface SandboxCompletedEvent {
  kind: 'sandbox.completed';
  traceId?: string; executionId: string;
  meta: SandboxResultMeta; exitCode: number | null; sandboxSuccess: boolean;
}
export interface AdapterCompletedEvent {
  kind: 'adapter.completed';
  traceId?: string; executionId: string;
  adapterSuccess: boolean; errorCode: string | null;
  outputValidated: boolean; outputValidationReason: string | null;
}
export interface RequestTerminalEvent {
  kind: 'request.completed' | 'request.failed';
  traceId: string; reason: string | null;
}
export interface RoutingCompletedEvent {
  kind: 'routing.completed';
  traceId?: string;
  intent: string; intentSource: 'llm' | 'original-query-fallback'; intentExtractionSucceeded: boolean;
  candidatesConsidered: number;
  selected: string | null; selectedRawScore: number | null; normalizedConfidence: number | null;
  candidates: Array<{ name: string; rawScore: number }>;
  selectionMethod: 'reranker' | 'score-fallback'; selectedCandidateRank: number | null;
}
export type TelemetryEvent =
  | SandboxCompletedEvent | AdapterCompletedEvent | RequestTerminalEvent | RoutingCompletedEvent;

export interface TelemetrySink { emit(event: TelemetryEvent): void; }
```

- [ ] **Step 1: Write a type-shape test**

```ts
import { describe, it, expect } from 'vitest';
import type { ExecutionContext, TelemetrySink, TelemetryEvent } from '../src/execution-context.js';

describe('ExecutionContext / TelemetrySink', () => {
  it('supports a sink emitting a sandbox.completed event', () => {
    const seen: TelemetryEvent[] = [];
    const sink: TelemetrySink = { emit: (e) => seen.push(e) };
    const ctx: ExecutionContext = { traceId: 'oct-e2e-x', executionId: 'exec-1' };
    sink.emit({ kind: 'sandbox.completed', traceId: ctx.traceId, executionId: ctx.executionId!, meta: { isolationLevel: 'full', backend: 'docker', degraded: false, degradationReasons: [] }, exitCode: 0, sandboxSuccess: true });
    expect(seen).toHaveLength(1);
    expect(seen[0]!.kind).toBe('sandbox.completed');
  });
});
```

- [ ] **Step 2: Run test to verify it fails (no module)**

Run: `pnpm --filter @agentoctopus/core exec vitest run tests/execution-context.test.ts`
Expected: FAIL — module not found.

- [ ] **Step 3: Implement `execution-context.ts` + export from index.ts**

Write the interfaces above; add `export * from './execution-context.js';` (or named exports) to `packages/core/src/index.ts`.

- [ ] **Step 4: Run test to verify it passes.** Expected: PASS.

- [ ] **Step 5: Commit**

```bash
git add packages/core/src/execution-context.ts packages/core/src/index.ts packages/core/tests/execution-context.test.ts
git commit -m "feat(core): ExecutionContext + TelemetrySink + layered event types

Co-Authored-By: Claude Sonnet 4.6 <noreply@anthropic.com>"
```

### Task 3.3: SandboxRunner emits sandbox.completed

**Files:**
- Modify: `packages/core/src/sandbox-runner.ts` (constructor deps + `run()` + `spawn()`/`doClose`)
- Test: `packages/core/tests/sandbox-runner-telemetry.test.ts`

**Interfaces:**
- Consumes: `ExecutionContext`, `TelemetrySink` (T3.2).
- Produces: `SandboxRunnerDeps` gains optional `execContext?: ExecutionContext` and `telemetrySink?: TelemetrySink`. Emits `SandboxCompletedEvent`:
  - `run()` completion: after `toRunOutput`/`toErrorOutput`, `meta` = final (downgraded) meta, `exitCode` from result (null on error), `sandboxSuccess` = `output.success`.
  - `spawn()` created: emit with the INITIAL meta (`isolationLevel: backend.isolationLevel`, `exitCode: null`, `sandboxSuccess: false`) BUT this is a "created" record — see note.
  - `spawn().close()/resultMeta`: after `resultMeta` resolves, emit with the FINAL downgraded `finalMeta`.

> **Merge-rule note:** the gateway aggregator (T3.6) merges all `sandbox.completed` events for the same `executionId` into ONE `runs[]` element, and assertions read only the FINAL state. So emitting a "created" event with initial meta is fine — the aggregator overwrites it when the final event arrives. Each `spawn()` session and each `run()` gets its OWN `executionId`. For `run()`, use the context's `executionId`. For `spawn()`, generate a fresh `executionId` per session (`crypto.randomUUID()`).

- [ ] **Step 1: Write the failing test**

```ts
import { describe, it, expect } from 'vitest';
import { SandboxRunner } from '../src/sandbox-runner.js';
import type { TelemetryEvent } from '../src/execution-context.js';
// Use a stub backend + minimal deps (the existing sandbox-runner tests show the
// DI seams: backends, proxyLauncher, installationIdFor, afterBuildSnapshot...).

describe('SandboxRunner telemetry', () => {
  it('emits sandbox.completed with final downgraded meta on run() completion', async () => {
    const events: TelemetryEvent[] = [];
    // … construct a SandboxRunner with a stub docker backend whose cleanup throws
    // ContainmentCleanupError, telemetrySink collecting events, execContext with
    // executionId 'exec-1', and assert the emitted sandbox.completed carries
    // meta.isolationLevel === 'none' (downgraded) and sandboxSuccess === false.
    expect(events.some(e => e.kind === 'sandbox.completed')).toBe(true);
  });
});
```

> The implementer mirrors the existing sandbox-runner test fixtures (stub `SandboxBackend`, stub `ProxyLauncher`, `installationIdFor`, `rmSessionDir`) to drive run() and spawn() deterministically. Assert: run() emits exactly one `sandbox.completed` with the final meta; spawn() emits a created event then a final event after `close()` resolves `resultMeta`, and the final event's meta reflects a containment downgrade (`isolationLevel: 'none'`) when cleanup throws `ContainmentCleanupError`.

- [ ] **Step 2: Run test to verify it fails**

Run: `pnpm --filter @agentoctopus/core exec vitest run tests/sandbox-runner-telemetry.test.ts`
Expected: FAIL — no telemetry emitted.

- [ ] **Step 3: Implement**

In `sandbox-runner.ts`:
- Add `execContext?: ExecutionContext` and `telemetrySink?: TelemetrySink` to `SandboxRunnerDeps`; store as private readonly fields.
- In `run()`, after computing the output (both `toRunOutput` and `toErrorOutput` paths), call `this.telemetrySink?.emit({...})` with the output's `meta`, `exitCode`, `success`.
- In `spawn()`, emit a created event after `backend.spawn()` succeeds (fresh `executionId`); in `doClose`, after `resolveResultMeta(finalMeta)`, emit the final event with `finalMeta`.

- [ ] **Step 4: Run test to verify it passes.** Expected: PASS.

- [ ] **Step 5: Commit**

```bash
git add packages/core/src/sandbox-runner.ts packages/core/tests/sandbox-runner-telemetry.test.ts
git commit -m "feat(core): SandboxRunner emits sandbox.completed (run + spawn created/final, downgraded meta)

Co-Authored-By: Claude Sonnet 4.6 <noreply@anthropic.com>"
```

### Task 3.4: Executor emits adapter.completed + request terminal events + OutputValidator

**Files:**
- Create: `packages/core/src/output-validator.ts`
- Modify: `packages/core/src/executor.ts` (constructor + `execute()`)
- Test: `packages/core/tests/executor-telemetry.test.ts`

**Interfaces:**
- Consumes: `ExecutionContext`, `TelemetrySink`, `AdapterCompletedEvent`, `RequestTerminalEvent` (T3.2).
- Produces:
  - `output-validator.ts`: `export type OutputValidator = (output: {success:boolean; rawText?:string; data?:unknown}) => Promise<{ok:boolean; reason?:string}>;` and `export async function runOutputValidator(v: OutputValidator, output, timeoutMs): Promise<{ok:boolean; reason:string|null}>` (Promise.race timeout; timeout → `{ok:false, reason:'validator timeout'}`; throw → `{ok:false, reason: message}`).
  - `Executor` constructor gains optional `execContext?: ExecutionContext`, `telemetrySink?: TelemetrySink`, `outputValidator?: OutputValidator`.
  - `execute()` emits `adapter.completed` after the adapter returns (for the adapter path; skipped for credential-missing/unsupported-runtime/composed-no-adapter early returns), and emits `request.completed`/`request.failed` in a `finally` covering the WHOLE execute (normal, credential-missing, unsupported-runtime, exception).

> **request terminal event ownership:** the spec says `/ask` outermost emits the terminal event (because the no-route fallback never reaches Executor). The gateway `/ask` (T3.7) owns the terminal event. Executor emits `request.completed`/`request.failed` ONLY as a backstop for direct `executor.execute()` callers (CLI uses no sink, so it's a no-op there). To avoid double-emission, the gateway suppresses Executor's terminal event by NOT relying on it — see T3.7: the gateway emits the terminal event itself after execute returns, and Executor does NOT emit one when a sink is provided by the gateway (the gateway passes `emitTerminalEvent: false`). Simplest correct rule: **the gateway /ask handler is the single terminal-event emitter; Executor never emits terminal events.** Implement Executor to emit only `adapter.completed`. This satisfies "every request emits exactly one terminal event."

- [ ] **Step 1: Write the failing test**

```ts
import { describe, it, expect } from 'vitest';
import { runOutputValidator } from '../src/output-validator.js';

describe('runOutputValidator', () => {
  it('returns ok:true when validator resolves ok', async () => {
    const r = await runOutputValidator(async () => ({ ok: true }), { success: true }, 1000);
    expect(r).toEqual({ ok: true, reason: null });
  });
  it('returns ok:false on timeout', async () => {
    const r = await runOutputValidator(() => new Promise(() => {}), { success: true }, 50);
    expect(r.ok).toBe(false);
    expect(r.reason).toMatch(/timeout/i);
  });
  it('returns ok:false with reason when validator reports invalid', async () => {
    const r = await runOutputValidator(async () => ({ ok: false, reason: 'missing temperature field' }), { success: true }, 1000);
    expect(r).toEqual({ ok: false, reason: 'missing temperature field' });
  });
});
```

Plus an Executor test asserting `adapter.completed` carries `adapterSuccess` from `adapterResult.success`, a normalized `errorCode`, and `outputValidated` from the injected validator (and that raw output never appears on the emitted event).

- [ ] **Step 2: Run tests to verify they fail**

Run: `pnpm --filter @agentoctopus/core exec vitest run tests/executor-telemetry.test.ts`
Expected: FAIL — no output-validator module, no adapter.completed.

- [ ] **Step 3: Implement**

`output-validator.ts` per the interface above. In `executor.ts`:
- Constructor: accept and store `execContext`, `telemetrySink`, `outputValidator`.
- In `execute()`, after `adapterResult` is produced (and after `detectHttpErrorInOutput` post-processing, so `adapterSuccess` reflects the final success flag), call `runOutputValidator` (only if `outputValidator` provided AND `adapterResult.success` — no point validating a failed output; emit `outputValidated:false, reason:'adapter failed'` otherwise), then emit `adapter.completed` with a normalized `errorCode` (map common cases: `EAI_AGAIN`, `ECONNREFUSED`, HTTP status substrings, egress `host not granted`; else first token of `error`).

- [ ] **Step 4: Run tests to verify they pass.** Expected: PASS.

- [ ] **Step 5: Commit**

```bash
git add packages/core/src/output-validator.ts packages/core/src/executor.ts packages/core/tests/executor-telemetry.test.ts
git commit -m "feat(core): Executor emits adapter.completed + injected async timeout OutputValidator

Co-Authored-By: Claude Sonnet 4.6 <noreply@anthropic.com>"
```

### Task 3.5: Router emits routing.completed

**Files:**
- Modify: `packages/core/src/router.ts` (`route()`)
- Test: `packages/core/tests/router-telemetry.test.ts`

**Interfaces:**
- Consumes: `ExecutionContext`, `TelemetrySink`, `RoutingCompletedEvent` (T3.2).
- Produces: `Router` constructor gains optional `telemetrySink?: TelemetrySink`. `route()` accepts optional `execContext?: ExecutionContext` in `opts`, and emits ONE `routing.completed` per `route()` call with:
  - `intent` = the `embedQuery` actually used.
  - `intentSource` = `'llm'` if the LLM-extracted intent was used, `'original-query-fallback'` otherwise (covers both the non-Latin JSON-parse/LLM-failure fallbacks AND the Latin trim/length fallback).
  - `intentExtractionSucceeded` = `intentSource === 'llm'`.
  - `candidatesConsidered` = `candidates.length` at the point the reranker prompt is built (after cosine topK + keyword-boost + previousSkill injection, router.ts:334-363).
  - `selected`/`selectedRawScore`/`normalizedConfidence` from the winning `RoutingResult` (`null` if `[]`).
  - `candidates` = `[{name, rawScore}]` for each candidate fed to the reranker.
  - `selectionMethod` = `'reranker'` if the LLM reranker produced the pick, `'score-fallback'` if the catch-block embedding fallback was used.
  - `selectedCandidateRank` = index of the selected skill in the raw-score-sorted candidate list (`null` if none).

- [ ] **Step 1: Write the failing test**

Construct a `Router` with a stub `chatClient`/`embedClient` and a collecting `telemetrySink`; call `route('weather in Tokyo', 20, { execContext: { traceId: 'oct-e2e-x' } })`; assert one `routing.completed` event with `intentExtractionSucceeded`, `candidatesConsidered > 0`, `selectionMethod`, and `selectedCandidateRank`. Mirror the existing router test fixtures for stubbing the chat/embed clients.

> The implementer must track `intentSource` through the intent-extraction block (router.ts:204-243): set a local `intentUsed = false`, set it `true` only where `embedQuery` is assigned the LLM-extracted phrase (non-Latin: `if (parsed.intent && parsed.intent.length < routingQuery.length)`; Latin: `if (trimmed && trimmed.length < query.length)`), and map `intentSource = intentUsed ? 'llm' : 'original-query-fallback'`. Track `selectionMethod` via whether the reranker path or the catch-block fallback produced the result.

- [ ] **Step 2: Run test to verify it fails**

Run: `pnpm --filter @agentoctopus/core exec vitest run tests/router-telemetry.test.ts`
Expected: FAIL — no routing.completed emitted.

- [ ] **Step 3: Implement**

Modify `Router` constructor + `route()` per the interface; thread `intentUsed`/`selectionMethod` locals; emit `routing.completed` at the single return point (wrap the multiple `return [...]` / `return []` paths — collect the result into a variable, emit, then return).

- [ ] **Step 4: Run test to verify it passes.** Expected: PASS.

- [ ] **Step 5: Commit**

```bash
git add packages/core/src/router.ts packages/core/tests/router-telemetry.test.ts
git commit -m "feat(core): Router emits routing.completed (intent source, candidates, scores, selection method)

Co-Authored-By: Claude Sonnet 4.6 <noreply@anthropic.com>"
```

### Task 3.6: gateway debug-telemetry ring buffer + aggregator

**Files:**
- Create: `packages/gateway/src/debug-telemetry.ts`
- Test: `packages/gateway/tests/debug-telemetry.test.ts`

**Interfaces:**
- Consumes: `TelemetryEvent` types from `@agentoctopus/core`.
- Produces:

```ts
export interface RunRecord {
  runId: string;
  status: 'pending' | 'complete' | 'failed';
  completedAt: number | null;
  receivedAt: number;
  apiKeyId?: string;
  queryHash?: string;      // sha256 of query (only when includeQuery=false)
  query?: string;          // only when includeQuery=true
  routing?: RoutingCompletedEvent;
  terminal?: RequestTerminalEvent;
  runs: Array<{ executionId: string; status: 'created' | 'final'; sandbox?: SandboxCompletedEvent; adapter?: AdapterCompletedEvent }>;
}
export class DebugTelemetryBuffer {
  constructor(capacity: number);
  record(event: TelemetryEvent, ctx: { apiKeyId?: string; receivedAt?: number }): void;
  getByRunId(runId: string): RunRecord | null;
  latest(): RunRecord | null;
}
```

Aggregation rules:
- Keyed by `traceId` (events without a traceId are ignored — they belong to non-E2E traffic).
- A record is created `pending` on the FIRST event with a given traceId (routing, sandbox.created, sandbox.completed, or terminal).
- `routing.completed` sets `record.routing`.
- `sandbox.completed` merges into `record.runs` by `executionId`: a created event upserts `{status:'created', sandbox}`; a final event (the one carrying the resolved meta) sets `status:'final'` and overwrites `sandbox`. (The runner signals final by emitting after resultMeta resolves; mark final when the event is the post-close one. Distinguish created vs final by an explicit flag on the emitted event if cleaner — add `phase: 'created' | 'final'` to `SandboxCompletedEvent` in T3.2 if needed.)
- `adapter.completed` merges `adapter` into the same `runs[]` element by `executionId` and sets `status:'final'`.
- `request.completed`/`request.failed` sets `record.terminal` and transitions status: `request.completed` → `complete`, `request.failed` → `failed`, BUT only when all registered `runs[]` are `final`. If terminal arrives before runs are final, set status but leave it pending-able? — **No:** the spec rule is "leave pending IFF terminal received AND all registered executionIds final." So on terminal: if all runs final → set `complete`/`failed` + `completedAt`; else → keep `pending` and re-evaluate on each subsequent event (when the last run goes final AND terminal already received → transition). Status is one-directional: once `complete`/`failed`, never back to `pending`.
- Ring buffer: evict oldest (by `receivedAt`) beyond capacity.

- [ ] **Step 1: Write the failing test**

```ts
import { describe, it, expect } from 'vitest';
import { DebugTelemetryBuffer } from '../src/debug-telemetry.js';

const meta = { isolationLevel: 'full' as const, backend: 'docker' as const, degraded: false, degradationReasons: [] };

describe('DebugTelemetryBuffer', () => {
  it('stays pending until terminal event AND all runs final', () => {
    const buf = new DebugTelemetryBuffer(10);
    buf.record({ kind: 'sandbox.completed', traceId: 't1', executionId: 'e1', meta, exitCode: 0, sandboxSuccess: true }, {});
    expect(buf.getByRunId('t1')!.status).toBe('pending');
    buf.record({ kind: 'request.completed', traceId: 't1', reason: null }, {});
    expect(buf.getByRunId('t1')!.status).toBe('complete');
    expect(buf.getByRunId('t1')!.completedAt).not.toBeNull();
  });

  it('completes a no-sandbox request with empty runs[] on terminal', () => {
    const buf = new DebugTelemetryBuffer(10);
    buf.record({ kind: 'request.failed', traceId: 't2', reason: 'no route' }, {});
    expect(buf.getByRunId('t2')!.status).toBe('failed');
    expect(buf.getByRunId('t2')!.runs).toEqual([]);
  });

  it('merges created + final sandbox events into one runs[] element by executionId', () => {
    const buf = new DebugTelemetryBuffer(10);
    buf.record({ kind: 'sandbox.completed', traceId: 't3', executionId: 'e1', meta, exitCode: null, sandboxSuccess: false }, {});
    buf.record({ kind: 'sandbox.completed', traceId: 't3', executionId: 'e1', meta, exitCode: 0, sandboxSuccess: true }, {});
    expect(buf.getByRunId('t3')!.runs).toHaveLength(1);
  });

  it('status is one-directional (never complete → pending)', () => {
    const buf = new DebugTelemetryBuffer(10);
    buf.record({ kind: 'request.completed', traceId: 't4', reason: null }, {});
    const before = buf.getByRunId('t4')!.status;
    buf.record({ kind: 'sandbox.completed', traceId: 't4', executionId: 'e1', meta, exitCode: 0, sandboxSuccess: true }, {});
    expect(buf.getByRunId('t4')!.status).toBe(before);
  });

  it('returns null for unknown runId', () => {
    const buf = new DebugTelemetryBuffer(10);
    expect(buf.getByRunId('nope')).toBeNull();
  });
});
```

> The "created vs final" merge test assumes a way to distinguish. Add `phase: 'created' | 'final'` to `SandboxCompletedEvent` (T3.2) so the aggregator can tell. Update T3.3 to emit `phase:'created'` on spawn-create and `phase:'final'` on run-complete and spawn-close. Adjust the first test to use `phase:'final'` events.

- [ ] **Step 2: Run test to verify it fails**

Run: `pnpm --filter @agentoctopus/gateway exec vitest run tests/debug-telemetry.test.ts`
Expected: FAIL — module not found.

- [ ] **Step 3: Implement `debug-telemetry.ts`** per the aggregation rules above.

- [ ] **Step 4: Run test to verify it passes.** Expected: PASS.

- [ ] **Step 5: Commit**

```bash
git add packages/gateway/src/debug-telemetry.ts packages/gateway/tests/debug-telemetry.test.ts packages/core/src/execution-context.ts
git commit -m "feat(gateway): DebugTelemetryBuffer — traceId aggregation, executionId merge, one-directional status

Co-Authored-By: Claude Sonnet 4.6 <noreply@anthropic.com>"
```

### Task 3.7: `/ask` correlation-key extraction + request terminal event + `/agent/debug/last-run` endpoint

**Files:**
- Modify: `packages/gateway/src/agent-protocol.ts` (`/ask` handler + new route)
- Modify: `packages/gateway/src/engine.ts` (construct Router/Executor with telemetry sink + ExecutionContext plumbing)
- Test: `packages/gateway/tests/agent-protocol-debug.test.ts`

**Interfaces:**
- Consumes: `DebugTelemetryBuffer` (T3.6), `ExecutionContext`/`TelemetrySink` (T3.2), `GatewayConfigSchema.debugEndpoints` (T3.1).
- Produces:
  - `/ask` handler: extract `oct-e2e-<uuid>` via regex `/\[trace:\s*(oct-e2e-[0-9a-f-]+)\s*\]/i` from the raw `query` BEFORE routing; strip the `[trace: ...]` substring from the query sent to Router/Executor; build an `ExecutionContext {traceId, apiKeyId (hash of the caller key), receivedAt}`; pass it to `router.route()` and `executor.execute()`; and in a `finally`-style outermost wrapper emit exactly ONE `request.completed`/`request.failed` (covering normal / credential-missing / unsupported-runtime / no-route / exception).
  - `engine.ts`: construct the shared `TelemetrySink` that forwards to the `DebugTelemetryBuffer`; pass it to `Router` and `Executor`. The `ExecutionContext` is per-request, so the engine can't hold it — instead, the sink is shared and the per-request context is passed at call time (Router.route/Executor.execute accept it as an arg). Executor's `sandboxRunner` also needs the context per execution — pass it via the Executor's `execute(..., execContext)` which forwards to `sandboxRunner` (extend `SandboxRunner` to accept the context per-call OR set it before execute). **Simplest correct wiring:** `Executor.execute(skill, input, opts)` gains `opts.execContext`; Executor stores it transiently and passes it to `sandboxRunner.bind()`-bound calls and its own emissions. The sandboxRunner emits with whatever context the Executor hands it. Coordinate with T3.3's mechanism (per-call context, not constructor).
  - `GET /agent/debug/last-run?runId=<id>`: admin-only (`req.apiKeyEntry.tier === 'admin'` else 403); if `!config.gateway.debugEndpoints.enabled` → 404; if `runId` given → `buf.getByRunId(runId)`; else → `buf.latest()`; if no match → 200 `{success:true, run:null}`; on hit → 200 `{success:true, run}` (strip `query` unless `includeQuery`).

- [ ] **Step 1: Write the failing test**

```ts
import { describe, it, expect, beforeAll } from 'vitest';
// Boot the agent router (createAgentRouter) with debugEndpoints.enabled=true,
// an admin key and a free key, and a stub engine whose router/executor emit
// telemetry through the shared sink. Assert:
//  - GET /agent/debug/last-run with a free key → 403
//  - GET /agent/debug/last-run with admin key, empty buffer → 200 {success:true, run:null}
//  - POST /agent/ask with '[trace: oct-e2e-…]' → after completion, GET ?runId=oct-e2e-…
//    returns a record with status non-pending and the trace stripped from routing
//  - debugEndpoints.enabled=false → GET → 404
```

> The implementer mirrors the existing agent-protocol test setup (how `createAgentRouter` is instantiated in tests with a stubbed engine/auth). Assert correlation extraction, trace stripping, admin-only enforcement, the three response states (404/200-run-null/200-run), and exactly-one terminal event per request (including a no-route request that never reaches Executor).

- [ ] **Step 2: Run test to verify it fails**

Run: `pnpm --filter @agentoctopus/gateway exec vitest run tests/agent-protocol-debug.test.ts`
Expected: FAIL — no debug route, no correlation extraction.

- [ ] **Step 3: Implement**

`agent-protocol.ts`:
- `/ask`: at the top of the handler (after query validation), `const traceMatch = query.match(/\[trace:\s*(oct-e2e-[0-9a-f-]+)\s*\]/i); const traceId = traceMatch?.[1]; const cleanQuery = traceId ? query.replace(traceMatch![0], '').trim() : query;` Use `cleanQuery` for routing/execution/session. Build the ExecutionContext. Wrap the route+execute+direct-answer logic so a terminal event is recorded exactly once (try/finally; record `request.failed` on exception, `request.completed` otherwise, including the no-route `!routing` return and the credential/unsupported returns).
- Wire the shared sink (from engine) into Router.route / Executor.execute calls with the per-request ExecutionContext.
- Add the `GET /debug/last-run` route (note: the router is mounted at `/agent`, so the route path is `/debug/last-run`).

`engine.ts`: create `const telemetryBuffer = new DebugTelemetryBuffer(config.gateway.debugEndpoints.bufferSize)` and a sink `{ emit: (e) => telemetryBuffer.record(e, {/* apiKeyId/receivedAt set by /ask */}) }`. Pass the sink to `new Router(rerankConfig, embedConfig, sink)` and `new Executor(registry, chatClient, router, sandboxRunner, { telemetrySink: sink })`. Expose `telemetryBuffer` on the returned `OctopusEngine` so the `/debug/last-run` route can query it.

> **apiKeyId/receivedAt binding:** the sink's `record(event, ctx)` needs the per-request `apiKeyId`/`receivedAt`. Since the sink is shared across concurrent requests, do NOT store per-request state on the sink. Instead, the `/ask` handler sets `apiKeyId`/`receivedAt` on the `ExecutionContext` it passes down, and the emissions carry them (add `apiKeyId?`/`receivedAt?` to the emitted events, or have the buffer read them from the event's context). Simplest: include `apiKeyId` and `receivedAt` on the `ExecutionContext`, and have each emitted event carry `traceId` (already does); the buffer looks up request metadata from a separate `recordRequestStart(traceId, {apiKeyId, receivedAt, queryHash})` call the `/ask` handler makes directly on the buffer. This keeps per-request metadata out of the shared sink.

- [ ] **Step 4: Run test to verify it passes.** Expected: PASS.

- [ ] **Step 5: Commit**

```bash
git add packages/gateway/src/agent-protocol.ts packages/gateway/src/engine.ts packages/gateway/tests/agent-protocol-debug.test.ts
git commit -m "feat(gateway): /ask correlation-key extraction + terminal event + admin-only /agent/debug/last-run

Co-Authored-By: Claude Sonnet 4.6 <noreply@anthropic.com>"
```

### Task 3.8: docs — agent-protocol.md + CLAUDE.md + TEST_INSTRUCTIONS.md

**Files:**
- Modify: `docs/api-reference/agent-protocol.md`
- Modify: `CLAUDE.md`
- Modify: `TEST_INSTRUCTIONS.md`

- [ ] **Step 1: Document `/agent/debug/last-run`** (admin-only, runId query, three response states, layered telemetry fields, correlation-key extraction on `/ask`, `gateway.debugEndpoints` config object).

- [ ] **Step 2: Update CLAUDE.md** — gateway section (debugEndpoints object config, debug endpoint, correlation-key extraction + trace stripping, layered telemetry aggregation), core section (`ExecutionContext.traceId` threading, Executor `adapter.completed`, executionId merge, OutputValidator), sandbox section (bootstrap egress mechanism, vendored undici, uid 65534), image build (vendor-undici.mjs).

- [ ] **Step 3: Add TEST_INSTRUCTIONS.md rows** for the new unit/integration tests and the manual E2E smoke.

- [ ] **Step 4: Commit**

```bash
git add docs/api-reference/agent-protocol.md CLAUDE.md TEST_INSTRUCTIONS.md
git commit -m "docs(gateway,core,sandbox): debug endpoint, ExecutionContext telemetry, bootstrap egress

Co-Authored-By: Claude Sonnet 4.6 <noreply@anthropic.com>"
```

---

## Phase 4 — Claude Code Test Skill (machine-only, NOT in repo) + hermes.md correction

### Task 4.1: `~/.claude/skills/hermes-e2e-test/` orchestrator

**Files:**
- Create (machine-only, NOT committed): `~/.claude/skills/hermes-e2e-test/SKILL.md`, `~/.claude/skills/hermes-e2e-test/run.mjs`
- No repo test (run.mjs is machine-only per spec; correctness guaranteed by the smoke itself).

**Interfaces:**
- Consumes: `hermes -z`, `octopus --version`, `GET /agent/health`, `GET /agent/debug/last-run` (admin key), `POST /agent/ask` (ask key), env `AGENTOCTOPUS_E2E_ASK_KEY` + `AGENTOCTOPUS_E2E_ADMIN_KEY`.
- Produces: 5-line PASS/FAIL + overall verdict; `--json` for machine-readable.

**run.mjs logic (the 7 steps from the spec, implemented verbatim):**

1. **Preflight** (any failure → actionable hint + non-zero exit): `hermes --version`; `octopus --version`; `GET /agent/health`; `GET /agent/debug/last-run` with `AGENTOCTOPUS_E2E_ADMIN_KEY` (404=endpoint off → hint to enable `debugEndpoints.enabled`; 401/403=key problem; 200 `{run:null}`=endpoint on but empty → NORMAL, continue); both keys present in env.
2. **Install octopus-wrapper forensics:** resolve real `octopus` absolute path FIRST (`which octopus` / `command -v octopus`); write a wrapper `octopus` into a temp dir; generate a one-time nonce. The wrapper spawns real octopus NORMALLY (NOT exec), captures exitCode/signal, atomically appends a JSONL marker line `{nonce, argv, calledAt, realExitCode, signal}`, exits with the same code. Prepend temp dir to PATH. (JSONL survives Hermes calling octopus multiple times.) finally: remove wrapper + temp dir.
3. **Hermes leg [1a]:** `hermes -z "<query>"` (default `"What's the weather in Tokyo?"`, `--query` overrides) under the wrapper PATH, `--timeout` (default 90s). No correlation key, no credentials. Record hermes exit code + stdout (corroboration only, not the criterion).
4. **Telemetry leg [1b]:** generate correlation key `oct-e2e-<uuid>` (crypto random), embed in query; run.mjs itself `POST /agent/ask` (header `Authorization: Bearer AGENTOCTOPUS_E2E_ASK_KEY`, body `{query: "…[trace: oct-e2e-<uuid>]"}`).
5. **Poll** `GET /agent/debug/last-run?runId=oct-e2e-<uuid>` (admin key) until `run.status !== 'pending'` AND the asserted `runs[]` elements are all final, or timeout (not just `run !== null`).
6. **5-stage assert:** stage 1 from [1a] + wrapper 4-point forensics (①hermes exit 0; ②marker ≥1 line nonce match; ③that line `argv[0]==='ask'`; ④that line `realExitCode===0` and no signal). Stages 2-5 from [1b] telemetry (stage 2: `intent` non-empty + `intentSource==='llm'` + `intentExtractionSucceeded===true` + `candidatesConsidered>0`; stage 3: `skill === expected` (`--expect-skill`, default `weather`); stage 4: score semantics — `score-fallback` ⇒ `selectedCandidateRank===0` + `normalizedConfidence>=threshold` (`--threshold` default 0.5), `reranker` ⇒ selected ∈ candidates; stage 5: `sandbox.backend==='docker'` + `isolationLevel==='full'` + `adapterSuccess===true` + `outputValidated===true`).
7. **Output** 5-line PASS/FAIL + verdict; `--json`.

**CLI args:** `--query`, `--expect-skill`, `--threshold`, `--timeout`, `--json`.

- [ ] **Step 1: Write `SKILL.md`** (name `hermes-e2e-test`; tells Claude Code: when the user says "运行这个测试", run `node run.mjs` and read PASS/FAIL back, guiding by the troubleshooting hints on failure).

- [ ] **Step 2: Write `run.mjs`** implementing the 7 steps above. Use only Node stdlib (`node:child_process`, `node:crypto`, `node:fs`, `node:os`, `node:path`, global `fetch`). The wrapper is a tiny shell/node script written to the temp dir. The error-table (from the spec) drives the per-failure hints.

> **Wrapper (Node script, written to `<tmp>/octopus`, chmod 0755):** shebang `#!/usr/bin/env node`; reads the real octopus path from an env var `OCT_REAL` the run.mjs exports; `spawn(OCT_REAL, process.argv.slice(2), {stdio:'inherit'})`; on `exit` (code, signal) append `JSON.stringify({nonce: process.env.OCT_NONCE, argv: process.argv.slice(2), calledAt: Date.now(), realExitCode: code, signal}) + '\n'` to `process.env.OCT_MARKER` via `fs.appendFileSync` (atomic enough for line-appends on POSIX); `process.exit(code ?? 1)`.

- [ ] **Step 3: Smoke it manually** (not in CI): `node ~/.claude/skills/hermes-e2e-test/run.mjs --json`. Requires: Hermes logged in, gateway running (`octopus start`), P0/P1/P2 config in place, both test keys created. Iterate until PASS. This is the acceptance gate for the whole project.

> **No commit** — machine-only. (The spec is explicit: run.mjs/SKILL.md do not enter the repo.)

### Task 4.2: hermes.md correction + TEST_INSTRUCTIONS E2E row

**Files:**
- Modify: `docs/integrations/hermes.md`
- Modify: `TEST_INSTRUCTIONS.md`

- [ ] **Step 1: Correct hermes.md** — remove the fictional `"tools":[{endpoint:.../agent/ask}]` JSON; rewrite to the real form: AgentOctopus is a Hermes skill at `~/.hermes/skills/openclaw-imports/agentoctopus/SKILL.md`, invoked via the `octopus` CLI (`octopus ask`). Add an "End-to-end verification" subsection: enable `debugEndpoints`, create the two test keys, run the test skill (run.mjs connects directly to `/ask`).

- [ ] **Step 2: Add the E2E smoke row** to TEST_INSTRUCTIONS.md (manual/smoke, not CI).

- [ ] **Step 3: Commit**

```bash
git add docs/integrations/hermes.md TEST_INSTRUCTIONS.md
git commit -m "docs(integrations): correct Hermes wiring to CLI-skill form + E2E verification

Co-Authored-By: Claude Sonnet 4.6 <noreply@anthropic.com>"
```

---

## Self-Review

**Spec coverage:**
- Phase 0 (sandbox prerequisites) → Task 0.1 (doctor) + config notes. ✅
- Phase 1 (egress fix) → Tasks 1.1-1.6 (bootstrap, Dockerfile/uid, vendor+lock, NODE_OPTIONS, contract+networking tests, sandbox.md). ✅
- Phase 2 (skill fixes) → Tasks 2.1-2.2 (weather/ip-lookup bins+hosts) + grants note. ✅
- Phase 3 (telemetry + debug endpoint) → Tasks 3.1-3.8 (config, ExecutionContext, runner events, executor events+validator, router events, buffer/aggregator, /ask+endpoint, docs). ✅
- Phase 4 (test skill) → Tasks 4.1-4.2 (run.mjs machine-only, hermes.md correction). ✅
- Five-stage assertions → Task 4.1 Step 6 + telemetry semantics in 3.4/3.5/3.6. ✅
- Two-leg independence → honored: no CLI telemetry, no orchestration convergence. ✅
- request terminal event at /ask outermost (user's final note) → Task 3.7 owns it; Executor explicitly does NOT emit terminal events (3.4). ✅

**Placeholder scan:** The only `todo` markers are the two `it.todo` in Task 1.5 Step 3, which are intentional integration-test contracts gated to the docker security lane, with an explicit implementation note. All other steps have concrete code. The undici sha256 is marked `<COMPUTE>` with the exact command — this is a value that must be computed at implementation time, not a placeholder for design.

**Type consistency:** `ExecutionContext`, `TelemetrySink`, `TelemetryEvent` (with `SandboxCompletedEvent` gaining a `phase` field per T3.6's note), `OutputValidator`, `RunRecord`, `DebugTelemetryBuffer` are defined once in T3.2/T3.4/T3.6 and consumed consistently in T3.3/3.4/3.5/3.7. The `/ask`-owns-terminal-event rule is consistent between 3.4 and 3.7. `buildDockerArgs`, `requestedHosts`/`requestedBins`, `resolveRuntimeProfile`, `lookupInstallationId`, `IMMUTABLE_IMAGE_RE`, `GatewayConfigSchema`, `createAgentRouter`, `bootstrapEngine` all match the verified source.

**Open coordination point for the implementer:** the per-request `ExecutionContext` plumbing into `SandboxRunner` (T3.3 constructor-injected vs T3.7 per-call). Resolve by passing the context per-call: `Executor.execute(..., opts.execContext)` forwards it to the runner's `run()`/`spawn()` calls (extend `SandboxCommandInput`/`SandboxRunInput` with an optional `execContext`), rather than constructor-injecting it on the shared runner. T3.3's "constructor deps" framing should be read as "runner accepts the context (per-call preferred) + a shared sink (constructor)." This keeps the shared `createDefaultSandboxRunner` safe across concurrent requests.
