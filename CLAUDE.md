# CLAUDE.md

This file provides guidance to Claude Code (claude.ai/code) when working with code in this repository.

## Development Rules

These rules apply to every code change, no exceptions.

### 1. Changeset, build & test before committing

After any code change, always:

```bash
# 1. Create a changeset (skip for docs/CI-only changes)
pnpm changeset

# 2. Build and test the affected packages
pnpm --filter <package> build
pnpm --filter <package> test
# For changes that touch multiple packages:
pnpm build && pnpm test
```

All tests must be green before a commit is made.

### 2. Keep documentation in sync

Apply these documentation updates alongside every code change — not after the fact:

| What changed | What to update |
|---|---|
| New feature, new skill, new API endpoint, new adapter | `README.md` — add to the relevant section |
| Phase milestone reached or task completed | `implementation_plan.md` — mark checkbox, update phase status |
| New testable behavior, new endpoint, changed CLI usage | `TEST_INSTRUCTIONS.md` — add or update the relevant test case and checklist row |
| Routing logic, env vars, package roles, Next.js constraints | `CLAUDE.md` — update the affected section |
| Any user-visible change | `docs/` directory — check relevant section under `docs/{introduction,getting-started,core-concepts,integrations,api-reference,deployment,contributing}/` and update any affected pages |

Before every commit, review the `docs/` directory and related markdown files to check whether the change affects any documented behavior, CLI commands, architecture, or integrations. If it does, update the relevant docs file(s) in the same commit.

Do **not** update docs for internal refactors with no user-visible behavior change.

### 3. Commit after every logical change

Commit immediately after completing a self-contained change (feature, fix, doc update). Do not batch unrelated changes into one commit.

Commit message format:
```
<type>(<scope>): <short summary>

<optional body explaining why, not what>

Co-Authored-By: Claude Sonnet 4.6 <noreply@anthropic.com>
```

Types: `feat`, `fix`, `docs`, `refactor`, `test`, `chore`
Scope: package or app name — `core`, `registry`, `adapters`, `gateway`, `web`, `cli`, `ip-lookup`, etc.

Stage only relevant files — never use `git add -A` blindly. Do not commit `dist/`, `.env`, or `registry/ratings.json`.

### 4. Adding or modifying a skill

When adding a new skill or changing how an existing skill routes:

1. Write `SKILL.md` with the new frontmatter format (no `adapter`, `endpoint`, `hosting`, or `auth` fields). Execution strategy is derived from directory contents (scripts/, MCP metadata). Use `requires.bins`, `requires.env`, `os`, and `always` for eligibility gating.
2. The Zod schema lives in `packages/skills/src/schema.ts`. Run `pnpm --filter @agentoctopus/skills test` to validate.
3. Smoke-test the `scripts/invoke.js` directly: `OCTOPUS_INPUT='{"query":"..."}' node registry/skills/<name>/scripts/invoke.js`
4. Reset `registry/ratings.json` entries for removed skills so stale data doesn't persist.
5. The web server caches the skill index at startup — restart it after adding/changing skills.
6. Add a test row to `TEST_INSTRUCTIONS.md`.

### 5. Phased development tracking

`implementation_plan.md` is the source of truth for project progress. When completing work from a phase:

- Check off the completed items with `[x]`
- Update the phase header from `⏳ Planned` → `✅ Complete`
- Update the test count in the Verification section

---

## Commands

```bash
pnpm install          # install all workspace dependencies
pnpm build            # build all packages (order: skills → registry → adapters → core → gateway → apps)
pnpm test             # run all tests across all workspaces (883 declared; 111 in the sandbox security suite)
pnpm dev              # watch mode for all packages in parallel

# Scoped commands
pnpm --filter @agentoctopus/core build
pnpm --filter @agentoctopus/core test
pnpm --filter web test

# Run a single test file
pnpm --filter @agentoctopus/registry exec vitest run tests/registry.test.ts

# CLI (must build first)
node apps/cli/dist/index.js list
node apps/cli/dist/index.js ask "What's the weather in Tokyo?"
node apps/cli/dist/index.js search "weather"      # search local skills with scored ranking
node apps/cli/dist/index.js search "weather" --run  # search and interactively pick a skill to run

# CLI evolution commands (must build first)
node apps/cli/dist/index.js evolve                  # show evolution status for all skills
node apps/cli/dist/index.js evolve --propose weather # analyze weather skill for improvements
node apps/cli/dist/index.js evolve --review          # review pending risky proposals
node apps/cli/dist/index.js evolve --log weather     # show snapshot history
node apps/cli/dist/index.js evolve --rollback weather --to 2  # roll back to snapshot #2

# CLI update commands (must build first)
node apps/cli/dist/index.js update          # check and install latest @agentoctopus packages
node apps/cli/dist/index.js update --check  # check only, don't install
node apps/cli/dist/index.js sync            # interactive: prompts to sync skills, ratings, or both
node apps/cli/dist/index.js sync --check    # check for skill updates only
node apps/cli/dist/index.js sync --cloud-url <url>  # also sync from cloud instance

# Rating sync commands
node apps/cli/dist/index.js sync --setup-gist     # set up GitHub Gist for rating sync
node apps/cli/dist/index.js sync --ratings --pull  # pull ratings from cloud
node apps/cli/dist/index.js sync --ratings --push  # push ratings to cloud
node apps/cli/dist/index.js sync --ratings         # bidirectional rating sync
node apps/cli/dist/index.js sync --pull            # shorthand: pull ratings
node apps/cli/dist/index.js sync --push            # shorthand: push ratings

# Web dev server
cd apps/web && pnpm dev   # http://localhost:3000
```

## Architecture

AgentOctopus is a **pnpm monorepo** (workspaces: `packages/*`, `apps/*`). All packages are ESM (`"type": "module"`), TypeScript targeting ES2022/NodeNext. Each package builds with `tsc` to its own `dist/`.

Published to npm under the `@agentoctopus/` scope, plus an `agentoctopus` umbrella package that re-exports everything.

### Request flow

```
User query
  → Gateway (CLI / REST API / IM bot / agent-protocol)
  → Router   — embeds query, cosine-scores against skill index,
               pre-filters with shouldIncludeSkill() from @agentoctopus/skills,
               LLM re-ranks, returns [] if no skill fits (→ direct LLM answer)
  → Executor — applies env overrides via @agentoctopus/skills,
               delegates ALL skill execution to SandboxRunner:
                 snapshot build → selectBackend (fail-closed)
                 → prepareTopology → egress-proxy launch → verifySnapshot
                 → prepare → run/spawn → cleanup
               on failure: tries next candidate (up to maxRetries, default 3)
               all failed → falls back to direct LLM answer
  → Result   — formatted, returned to caller; feedback updates ratings.json
```

### Sandbox execution (critical to understand)

Every skill runs in a sandbox backend selected at runtime via `selectBackend` (`packages/sandbox/src/backend.ts`). Selection is **fail-closed**: each backend probes its own privileges before ranking, and a backend is admitted only when its post-probe `isolationLevel` meets `minIsolationLevel`. Under the default `auto` + `minIsolationLevel:'full'`, when no `full` backend is available the run throws `NoFullBackendError` — never a host fallback. Restricted OS execution is opt-in only, selectable solely with exactly `defaultBackend:'os'` + `minIsolationLevel:'restricted'`; `auto` never picks a restricted backend implicitly.

Key config sections in `octopus.json` → `sandbox`:

| Field | Role |
|---|---|
| `sandbox.grants` | Per-execution requested capability set; the backend grants only `requested ∩ enforceable`. |
| `sandbox.defaultBackend` | `'auto'` (default) \| `'docker'` \| `'os'`. Restricted OS requires `'os'` plus a restricted floor. |
| `sandbox.minIsolationLevel` | `'full'` (default) \| `'restricted'` \| `'remote-unverified'` \| `'none'`. The fail-closed floor. |
| `sandbox.docker.image` | Runtime image ref — must be an immutable digest (`repo@sha256:<64hex>` or `sha256:<64hex>`); mutable tags are rejected by the image-contract tests. |
| `sandbox.proxy.artifact` | Egress-proxy image ref — same immutable-digest rule; the proxy is the skill's sole network egress. |

**Immutable digest validation.** `identity = installationId + digest` (`sha256:` + 64 lowercase hex, validated against `SNAPSHOT_DIGEST_RE`). The runner re-verifies the digest immediately before `backend.prepare()`; any mutation between build and verify aborts with `SNAPSHOT_MISMATCH`. Backends assert the digest FORMAT before any mount; the byte-for-byte re-verify against the snapshot tree is the runner's last filesystem operation before `prepare`.

**Three CI runner classes** (security matrix, `packages/sandbox/tests/security/`):

| Runner class | CI label | Claims it owns | Skip behavior |
|---|---|---|---|
| Hosted Docker + proxy | `hosted-docker-proxy` (`ubuntu-latest`) | Harness + immutable-image contract, real Docker isolation + sidecar topology, egress proxy adversarial matrix, identity/snapshot integrity, MCP stdio over Docker. | Does NOT claim Linux netns/nftables/cgroup. |
| Privileged Linux | `privileged-linux` (`[self-hosted,linux,x64,sandbox-privileged]`) | Real Linux OS backend, named-netns proxy topology, nftables, cgroup-v2 enforcement. `OCTOPUS_REQUIRE_PRIVILEGED_LINUX=1` makes unavailable capabilities fatal; the Vitest JSON report must contain zero skipped/pending/todo/failed/timed-out tests. Also the lane that qualifies the linux-x64 VM TCB (G1/G2 boot a real guest under KVM) + signs its release manifest and uploads `vm-tcb-linux-x64-qualified` for the release pack job — but this block is gated on a `kvm-probe` step: when `/dev/kvm` is absent (a non-nested-virt runner, e.g. a standard EC2 guest) the qualification skips with a clear message, mirroring the vm-lane HVF skip, so the OS isolation lane still runs/passes while the TCB is qualified on a KVM-capable runner before release (the pack job fails closed without the qualified artifact). | Fork PRs skip (trust boundary); same-repo PRs and `workflow_call` (release) run it. Never claimed from macOS. |
| macOS restricted | `macos-restricted` (`macos-15`) | The real `sandbox-exec` behavioral branch when enforcement is available, or the explicit unavailable/full-rejected branch otherwise. | Never claims full isolation on Darwin. |
| VM (libkrun) | `vm-lane` (`macos-15`, `OCTOPUS_VM_LANE=1`, `needs: [produce-linux-artifacts, vm-hvf-probe]`, `if: needs.vm-hvf-probe.outputs.hvf == 'available'`) | Real libkrun guest L3/L4 escape matrix + G1/G2 qualification gates → gate manifest + signed detached release-manifest pair, with the gates + signature run BEFORE the L3/L4 tests (the tests' `probe()` reads those manifests). The guest rootfs is cross-produced on `produce-linux-artifacts` (build-vm-rootfs.mjs is Linux-only): full linux-x64 TCB + BOTH guest arches — the linux-arm64 guest node is a pinned+sha256-verified nodejs.org download (`OCTOPUS_ROOTFS_NODE_ARM64`); each rootfs is emitted as top-level `rootfs.img` (gates) and `rootfs/<ref>` (runtime). The macOS lane consumes ONLY the linux-arm64 rootfs (guest arch = host arch; no x64 fallback), builds its own darwin-arm64 helper + libkrun/libkrunfw in-run, and uploads the qualified+tested `vm-tcb-darwin-arm64` for the release pack job. | **Environment-specific qualification gate, not an unconditional hosted-CI gate.** The companion `vm-hvf-probe` job (macos-15) compiles a ~20-line C program calling `hv_vm_create(NULL)` ad-hoc-signed with only the hypervisor entitlement and outputs `hvf=available\|unavailable`. vm-lane is `skipped` (job-level `if`) ONLY for the recognized nested-virtualization limitation — GitHub-hosted macos-15 runners are Virtualization.framework guests and HVF denies nested `hv_vm_create`. On a physical Apple Silicon runner (hvf=available) the lane runs for real and stays fail-closed end to end: `assert-no-skipped-tests.mjs` fails on ANY skip, a NO-GO G1/G2 fails, and on same-repo events a missing signing secret fails (fork PRs skip signing only, soft `releaseManifest:'missing'`). `security-gate` accepts `vm-lane = success` OR that specific `skipped`, and when skipped prints "VM qualification not executed on this runner"; every other outcome (real VM failure, cancellation, unexpected skip) stays fail-closed. |

**Release prerequisite.** Release Preflight invokes the `sandbox-security.yml` reusable workflow for the exact preflight commit, records both immutable image IDs + the API-resolved security-gate job conclusion, and Release Publish re-verifies that gate against the live GitHub API before any `npm publish` — failing closed if `master` has moved since preflight. The pack job additionally downloads both qualified VM TCB artifacts (`vm-tcb-darwin-arm64` from vm-lane, `vm-tcb-linux-x64-qualified` from privileged-linux), refuses to pack if either platform's helper/libs/manifests/sealed rootfs/release signature is missing, and asserts the `@agentoctopus/sandbox-vm-native` tarball actually contains the full signed TCB for both platforms — no empty-shell native package can be published. Local verification can run fixture/unit tests, Docker lanes, and the macOS lane, but cannot verify the privileged job, the API-returned reusable-workflow job naming, or release dispatch behavior.

### Package responsibilities

| Package | Key files | Role |
|---|---|---|
| `packages/agentoctopus` | `index.ts` | Umbrella re-export of all sub-packages |
| `packages/skills` | `types.ts`, `schema.ts`, `frontmatter.ts`, `config.ts`, `local-loader.ts`, `workspace.ts`, `snapshot.ts`, `install.ts`, `clawhub-install.ts`, `command-specs.ts`, `env-overrides.ts`, `evolution/` | SKILL.md loading/parsing, eligibility pipeline, install system, env overrides, prompt snapshot building, skill self-improvement system |
| `packages/registry` | `registry.ts`, `rating.ts`, `rating-dimensions.ts` | Delegates SKILL.md loading to `@agentoctopus/skills`, persists ratings/invocations to `registry/ratings.json` |
| `packages/core` | `router.ts`, `executor.ts`, `llm-client.ts`, `sandbox-runner.ts`, `sandbox-runner-factory.ts`, `sandbox-vm-assembly.ts` | Embedding index, cosine similarity, LLM re-rank, skill execution — uses `@agentoctopus/skills` for eligibility and env overrides. `SandboxRunner` is the single orchestration point for all skill execution: snapshot build → `selectBackend` (fail-closed) → `prepareTopology` → egress-proxy launch → `verifySnapshot` → `prepare` → `run`/`spawn` → `cleanup`. Persistent sessions use `SandboxProcess` (subprocess) / `SandboxMcpTransport` (MCP stdio) bound via `SandboxRunner.bind()`. |
| `packages/adapters` | `http-adapter.ts`, `mcp-adapter.ts`, `subprocess-adapter.ts` | Three execution strategies — HTTP POST, MCP stdio, Node subprocess |
| `packages/sandbox` | `backend.ts`, `docker/`, `os/`, `vm/`, `proxy/`, `snapshot.ts`, `policy.ts`, `secrets.ts`, `schema.ts` | Leaf isolation package (imports nothing from `@agentoctopus/*` or native). `selectBackend` + `NoFullBackendError`, `DockerBackend`, `OsSandboxBackend`, `VmSandboxBackend`, egress proxy (`egress-proxy.ts`, CA, policy engine, DNS, headers, secret channel), immutable snapshot + digest identity, requested∩granted policy. Native VM helpers live in `packages/sandbox-vm-native` (dynamic-imported only from `core`). |
| `packages/sandbox-vm-native` | `vm-helper.c`, `vm-init.c`, `vm-image-builder.c`, `engine.ts`, `image-builder.ts`, `executables-qualified.ts`, `scripts/build-vm-helper.mjs`, `scripts/build-vm-rootfs.mjs`, `scripts/vendor-libkrun.mjs`, `scripts/run-vm-gates.mjs`, `scripts/sign-release-manifest.mjs` | Native VM backend: libkrun helper (Task 11), guest bootstrap PID 1 (Task 12), sealed ext4 image-builder (Task 13), `VmEngineImpl` + `posix_spawn` FD plumbing R9/R10 (Task 14). Producer scripts build the TCB — rootfs via `mke2fs` (not the C writer), libkrun from pinned source + libkrunfw v5.5.0 prebuilt — and run G1/G2 qualification gates + Ed25519-sign the release manifest. Dynamic-imported by `core`'s `createVmBackend`; never imported by the leaf `sandbox` package. |
| `packages/gateway` | `engine.ts`, `session.ts`, `slack/discord/telegram.ts`, `agent-protocol.ts`, `control-plane/`, `channels/`, `security/` | Shared engine bootstrap, 30-min session manager, IM bots, OpenClaw-compatible HTTP API, event bus, Webhook/WebChat channels, DM pairing |
| `apps/web` | `src/app/api/ask/route.ts`, `src/app/page.tsx` | Next.js REST API + chat demo UI |
| `apps/cli` | `src/index.ts`, `src/update.ts`, `src/sync-skills.ts`, `src/clawhub.ts`, `src/evolve.ts`, `src/connect.ts` | Commander CLI (`list`, `ask`, `update`, `sync`, `onboard`, `skill`, `evolve`, `connect`, `agent`) — ClawHub re-exports from `@agentoctopus/skills` |

### Routing logic (critical to understand)

`router.ts` has two layers of filtering before a skill is chosen:

1. **`shouldIncludeSkill()`** from `@agentoctopus/skills` — per-skill eligibility based on SKILL.md frontmatter: OS compatibility, required binaries, required env vars, required config paths, and bundled skill allowlists. Skills declare their own requirements declaratively. `always: true` bypasses all gates.

2. **LLM re-rank** — sends top-K candidates to the chat LLM with a prompt that includes `"none"` as a valid answer. `parseRerankDecision()` handles fuzzy LLM output. If `"none"` is returned or the re-rank fails, `route()` returns `[]`.

When `route()` returns `[]`, callers (web API, agent-protocol, IM bots) fall back to answering directly with the chat LLM.

### Rating dimensions

Each skill is rated on 5 dimensions:
- **completion** (0-1, objective) — success rate from auto-collected metrics
- **quality** (0-5, subjective) — EMA of user feedback (thumbs up/down)
- **reliability** (0-1, objective) — 1 - error rate from auto-collected metrics
- **latency** (0-1, objective) — normalized speed from auto-collected metrics
- **tokenCost** (0-1, objective) — cost efficiency from auto-collected metrics

The router computes a composite `routingScore` (0-1) using task-type-aware weights:
- one-shot: completion=0.30, quality=0.25, reliability=0.20, latency=0.15, tokenCost=0.10
- long-running: reliability=0.30 (crashes are costly)
- agent-collab: quality=0.30 (output feeds other agents)

Feedback is collected from CLI (thumbs up/down), web (thumbs up/down), and agent platforms (NLP keyword sentiment detection).

### Skills

Skills live in `registry/skills/<name>/SKILL.md` (gray-matter YAML frontmatter + markdown instructions) with an optional `scripts/invoke.js` for subprocess adapter. The Zod schema is in `packages/skills/src/schema.ts`. Execution strategy is derived from directory contents (scripts/, MCP metadata), not declared in frontmatter.

Current real skills (all free APIs, no keys):
- **weather** — wttr.in
- **translation** — MyMemory API
- **ip-lookup** — ip-api.com (requires actual IP/domain in query)

The evolution system (`packages/skills/src/evolution/`) enables skills to self-improve based on execution signals and user feedback. It runs as a background scheduler and can be triggered manually via `octopus evolve`. Evolution is opt-in (`evolution.enabled` in `octopus.json`).

### Environment

Configuration is loaded from `~/.agentoctopus/octopus.json` (v2 format) with `${ENV_VAR}` secrets resolved from `~/.agentoctopus/.env`. See `packages/core/src/config-resolver.ts`.

Key config sections:
- `llm` — provider, model, apiKey, baseUrl
- `embed` — provider, model, apiKey, baseUrl
- `rerank` — model
- `deploy` — mode ("local" | "cloud"), root
- `gateway` — port, corsOrigins, cloudUrl, syncOnStartup
- `skills` — allowBundled, entries (per-skill apiKey/env/config), load (extraDirs, watch), limits, installPrefs
- `evolution` — enabled (opt-in skill self-improvement)

Embedding and re-ranking can use a different provider/endpoint than the main LLM. The web `initOctopus()` in `apps/web/src/app/api/ask/route.ts` is a singleton — restart the server after changing skills or config.

### Next.js specifics

- Config lives in `apps/web/next.config.mjs` only (`.ts` was removed).
- `@agentoctopus/adapters` must stay in `serverExternalPackages`, not `transpilePackages` — it uses Node-native APIs incompatible with the Turbopack bundler.
- `apps/web/AGENTS.md` warns that this Next.js version (16.x) has breaking API changes — read `node_modules/next/dist/docs/` before touching framework-level code.

### Versioning & Publishing

All 8 packages share a single version managed by [changesets](https://github.com/changesets/changesets) with fixed versioning (`.changeset/config.json`). The umbrella `agentoctopus` package re-exports everything. To release:

1. **PR must include a changeset** — run `pnpm changeset` to create a `.changeset/*.md` file describing the change. CI enforces this via `changeset-check.yml` (skipped for docs/CI-only changes, dependabot PRs, or `skip-changeset` label).
2. **Merge PR to master** — triggers `release-preflight.yml` automatically: validates version is not already on npm, runs full lint+build+test, packs all 8 tarballs, uploads as preflight artifact.
3. **Manual dispatch** — maintainer triggers `release-publish.yml` via Actions UI, providing the preflight run ID. Downloads the artifact, verifies provenance, publishes in dependency order (sandbox → sandbox-vm-native → skills → registry → adapters → core → gateway → cli → agentoctopus) with 3x retry, creates GitHub Release from changelog.
4. **npm dist-tags** — choose `latest` or `beta` when dispatching. Use `beta` for pre-releases.

The `agentoctopus` umbrella package tarball uses `agentoctopus-[0-9]*.tgz` glob to avoid matching scoped packages (e.g., `agentoctopus-skills-X.Y.Z.tgz`, `agentoctopus-sandbox-vm-native-X.Y.Z.tgz`).
