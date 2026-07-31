# AgentOctopus — Implementation Plan (Updated)

AgentOctopus is an **intelligent routing layer** that sits between users and a registry of Skills/MCPs. When a user expresses a need in natural language, the system automatically selects, invokes, and returns results from the best-matching service — with **zero installation required** by the end user.

---

## Vision

```
User: "Translate this text to French"
         │
   (via CLI / IM / API / Agent)
         ▼
   ┌─────────────────┐
   │  AgentOctopus   │  ← understands intent, picks the right "tentacle"
   └─────────────────┘
         │
   ┌─────▼─────────────────────────────────────────┐
   │  Routing Engine (semantic search + rating)    │
   └─────┬──────────────────────────────────────── ┘
         │
   ┌─────▼──────────────────────┐
   │  Translation Skill / MCP   │  (cloud or local)
   └────────────────────────────┘
         │
   Result + feedback loop → rating update
```

---

## Core Design Principles

1. **Zero-install UX** — Users express intent; skills/MCPs run server-side or in isolated sandboxes.
2. **Intent-first routing** — Route by semantic understanding + quality signal from user feedback.
3. **Rating-aware selection** — Skills/MCPs earn scores from user feedback; better-rated ones are preferred.
4. **Multi-channel input** — Accept input from CLI, REST, IM platforms (Slack, Discord, Telegram), and other agents (e.g., OpenClaw).
5. **Hybrid execution** — Skills/MCPs can run in the cloud or locally (Docker / subprocess).
6. **Flexible LLM backend** — Use cloud LLMs (OpenAI, Gemini) or local models (Ollama) depending on config.

---

## Architecture Overview

```
┌──────────────────────────────────────────────────────┐
│                    AgentOctopus                      │
│                                                      │
│  ┌─────────────────────────────────────────────┐    │
│  │                  Gateway                    │    │
│  │ CLI │ REST API │ IM bots │ Agent protocol   │    │
│  └──────────────────┬──────────────────────────┘    │
│                     │                               │
│  ┌──────────────────▼──────────────────────────┐    │
│  │          Router (Intent Engine)             │    │
│  │  embed query → vector search → LLM re-rank  │    │
│  │  + rating boost from feedback scores        │    │
│  └──────────────────┬──────────────────────────┘    │
│                     │                               │
│  ┌──────────────────▼──────────────────────────┐    │
│  │              Registry                       │    │
│  │  SKILL.md manifests + MCP catalogs          │    │
│  │  + rating store (per skill/MCP)             │    │
│  └──────────────────┬──────────────────────────┘    │
│                     │                               │
│  ┌──────────────────▼──────────────────────────┐    │
│  │             Executor / Adapters             │    │
│  │  HTTP | MCP SSE | subprocess | Docker       │    │
│  └─────────────────────────────────────────────┘    │
└──────────────────────────────────────────────────────┘
```

### Component Breakdown

| Component | Responsibility |
|---|---|
| **Gateway** | Accepts input from CLI, REST, IM platforms (Slack/Discord/Telegram), and agent-to-agent calls (OpenClaw etc.) |
| **Router** | Embeds user query, does vector search over skill descriptions, re-ranks with LLM, applies rating boost |
| **Registry** | Stores SKILL.md manifests + MCP server entries, persists rating scores |
| **Executor** | Invokes the chosen skill/MCP via appropriate adapter (HTTP, MCP, subprocess, Docker) |
| **Rating System** | Collects thumbs-up/down or star ratings post-execution, updates per-skill score |
| **Result Aggregator** | Merges outputs for multi-skill composition, formats final response |

---

## Skill Manifest Format

Skills are described using **Markdown files with YAML frontmatter**, following the [Claude Skills](https://code.claude.com/docs/en/skills) convention:

```
registry/skills/translation/
├── SKILL.md          # Main manifest (required)
├── examples.md       # Sample prompts and outputs
└── scripts/
    └── invoke.ts     # Execution helper (optional)
```

**Example `SKILL.md`:**

```markdown
---
name: translation
description: >
  Translates text between languages. Use when the user asks to translate
  text, convert language, or says things like "in French" or "en Español".
tags: [translation, language, text]
version: 1.0.0
endpoint: https://api.example.com/translate
adapter: http
input_schema:
  text: string
  target_language: string
output_schema:
  translated_text: string
auth: api_key
rating: 4.7
invocations: 1240
---

## Instructions

Call the translation endpoint with the user's text and target language.
Return the result as plain readable text.
```

---

## Project Structure (TypeScript / Next.js)

```
AgentOctopus/
├── README.md
├── package.json
├── tsconfig.json
│
├── apps/
│   ├── web/                    # ✅ Next.js web app + REST API (Phase 2)
│   │   ├── src/app/
│   │   │   ├── api/
│   │   │   │   └── ask/route.ts          # ✅ POST /api/ask
│   │   │   └── page.tsx
│   │   ├── tests/
│   │   │   └── api.test.ts               # ✅ Integration test
│   │   └── package.json
│   │
│   └── cli/                    # ✅ CLI entry point (Phase 1)
│       ├── src/index.ts
│       └── package.json
│
├── packages/
│   ├── core/
│   │   ├── src/
│   │   │   ├── router.ts           # ✅ Intent embedding + skill selection
│   │   │   ├── executor.ts         # ✅ Skill/MCP/sandbox/composed invocation
│   │   │   ├── planner.ts          # ✅ Multi-hop intent decomposition
│   │   │   ├── composer.ts         # ✅ Skill composition DAG executor
│   │   │   └── llm-client.ts       # ✅ Pluggable LLM backend
│   │   └── tests/
│   │       ├── router.test.ts
│   │       ├── executor.test.ts
│   │       └── integration.test.ts  # ✅ End-to-end test
│   │
│   ├── registry/
│   │   ├── src/
│   │   │   ├── registry.ts         # ✅ Load/search/CRUD for skill manifests
│   │   │   ├── manifest-schema.ts  # ✅ Zod schema (incl. sandbox + compose)
│   │   │   └── rating.ts           # ✅ Rating store (file-based)
│   │   └── tests/
│   │       ├── registry.test.ts
│   │       ├── rating.test.ts
│   │       └── manifest-schema.test.ts
│   │
│   ├── adapters/
│   │   ├── src/
│   │   │   ├── http-adapter.ts     # ✅ Generic REST skill adapter
│   │   │   ├── mcp-adapter.ts      # ✅ MCP stdio bridge (Phase 2)
│   │   │   ├── subprocess-adapter.ts # ✅ Local script execution
│   │   │   └── sandbox/            # ✅ Phase 4b: Docker / SSH / OpenShell
│   │   │       ├── docker-adapter.ts
│   │   │       ├── ssh-adapter.ts
│   │   │       └── openshell-adapter.ts
│   │   └── tests/
│   │       └── mcp-adapter.test.ts  # ✅ MCP adapter tests
│   │
│   ├── skills/
│   │   ├── src/
│   │   │   ├── schema.ts           # ✅ SKILL.md frontmatter Zod schema
│   │   │   ├── composition/        # ✅ Phase 4b: composition schema + validation
│   │   │   │   ├── schema.ts
│   │   │   │   └── runner.ts
│   │   │   └── evolution/          # ✅ Skill self-improvement system
│   │   └── tests/
│   │
│   └── gateway/                    # ✅ Phase 3 + 4b Complete
│       ├── src/
│       │   ├── engine.ts           # ✅ Per-workspace engine bootstrap
│       │   ├── session.ts          # ✅ Stateful session manager
│       │   ├── channels/           # ✅ Phase 4b: unified channel architecture
│       │   │   ├── base-channel.ts
│       │   │   ├── channel-handler.ts
│       │   │   ├── slack-channel.ts
│       │   │   ├── discord-channel.ts
│       │   │   ├── telegram-channel.ts
│       │   │   ├── webhook-channel.ts
│       │   │   └── webchat-channel.ts
│       │   ├── control-plane/      # ✅ Phase 4b: event bus + control plane
│       │   │   ├── event-bus.ts
│       │   │   └── control-plane.ts
│       │   ├── multi-agent/        # ✅ Phase 4b: agent pool + routing
│       │   │   ├── agent-instance.ts
│       │   │   ├── agent-pool.ts
│       │   │   └── agent-router.ts
│       │   ├── security/           # ✅ Phase 4b: DM policy + pairing
│       │   │   ├── dm-policy.ts
│       │   │   └── pairing-store.ts
│       │   ├── agent-protocol.ts   # ✅ Agent-to-agent HTTP protocol + security
│       │   ├── auth-middleware.ts  # ✅ API key auth + tier management
│       │   ├── rate-limiter.ts     # ✅ Sliding-window rate limiting
│       │   ├── audit-logger.ts     # ✅ Structured JSONL request logging
│       │   └── index.ts            # ✅ Package entry point
│       └── tests/
│           └── gateway.test.ts     # ✅ 11 tests
│
└── registry/
    └── skills/                 # Built-in SKILL.md manifests
        ├── web-search/SKILL.md
        ├── translation/SKILL.md
        └── code-runner/SKILL.md
```

---

## Rating System Design

```
User submits request
       │
       ▼
   Skill selected & executed
       │
       ▼
   Result returned + prompt: "Was this helpful? 👍 / 👎"
       │
       ├── 👍  → score += weight (e.g. +0.1, capped at 5.0)
       └── 👎  → score -= weight; flag for review if score < 2.0
```

- Each skill stores `{ rating: number, invocations: number, recentFeedback: FeedbackEntry[] }` in `registry/ratings.json`.
- Router applies a **rating multiplier** during re-ranking: higher-rated skills get a boost in final score.
- Skills below a threshold (e.g., < 2.0 stars after 50+ uses) are automatically deprioritized.

---

## LLM Backend (Configurable)

```
# .env / config
LLM_PROVIDER=openai          # or: gemini | ollama
LLM_MODEL=gpt-4o             # or: gemini-2.0-flash | llama3.2
OLLAMA_BASE_URL=http://localhost:11434
```

- Router uses whichever LLM is configured for intent extraction and skill re-ranking.
- Local Ollama model is the default for dev/offline use; cloud LLM is recommended for production quality.

---

## Auth & Privacy (Suggested Approach)

> [!IMPORTANT]
> **Suggested auth design** — please confirm if this fits your expectations.

| Concern | Suggested Solution |
|---|---|
| **3rd-party API keys** | Each skill's `SKILL.md` declares `auth: api_key`. Keys are stored in a local encrypted vault (`~/.octopus/credentials.enc`) or a secrets manager (Vault, AWS Secrets Manager). AgentOctopus injects them at runtime — users never need to touch them. |
| **User identity** | Sessions are identified by a session token (CLI) or user ID (IM). No PII is sent to skills unless the user explicitly includes it in their query. |
| **Data in transit** | All outbound skill calls use HTTPS. MCP SSE connections also use TLS. |
| **Local-first option** | For sensitive workloads, users can mark skills as `hosted: local` — these run entirely on the user's machine via subprocess or Docker, with no data leaving the device. |
| **Audit log** | Every routing decision is logged locally (skill chosen, timestamp, success/failure) for transparency. |

---

## Phased Development Roadmap

### Phase 1 — CLI MVP ✅ Complete
- [x] Define `SKILL.md` manifest schema (Zod validation).
- [x] Build the **Registry** — load manifests from `registry/skills/`, search by tags + description.
- [x] Build the **Router** — semantic embedding, LLM re-rank, rating-aware selection.
- [x] Build the **Executor** — call HTTP/subprocess skills, return structured results.
- [x] Build **`apps/cli`** — `octopus ask "..."` command that runs the full pipeline.
- [x] Add basic **rating collection** via CLI prompt after each response.
- [x] Full unit + integration test suite (`pnpm test` all green).

### Phase 2 — MCP Protocol & REST API ✅ Complete
- [x] `mcp-adapter.ts` — `stdio` transport via `@modelcontextprotocol/sdk`; dynamically lists and calls tools.
- [x] `POST /api/ask` REST endpoint (Next.js API route in `apps/web`).
- [x] Unit tests: `packages/adapters/tests/mcp-adapter.test.ts`.
- [x] Integration test: `apps/web/tests/api.test.ts`.
- [x] `POST /api/feedback` for rating updates — `apps/web/src/app/api/feedback/route.ts`.
- [x] Remote MCP catalog discovery — `packages/registry/src/catalog.ts` (`fetchRemoteCatalog`).

### Phase 3 — IM & Agent Input ✅ Complete
- [x] Slack / Discord / Telegram bot adapters — `packages/gateway/src/{slack,discord,telegram}.ts`.
- [x] Agent-to-agent protocol (OpenClaw-compatible Express router) — `packages/gateway/src/agent-protocol.ts`.
- [x] Stateful session management across turns — `packages/gateway/src/session.ts`.
- [x] Shared engine bootstrap — `packages/gateway/src/engine.ts`.
- [x] 10 tests in `packages/gateway/tests/gateway.test.ts` ✅.

### Phase 4 — Intelligence & Composition ✅ Complete
- [x] Multi-hop routing: decompose complex requests into sub-tasks.
- [x] LLM planner that generates an execution DAG.
- [x] Confidence scoring; graceful "no matching skill" message.
- [x] **Structured output passing** between planner steps (JSON-aware context).
- [x] **Composite step detection** — planner recognizes `adapter: composed` skills.

### Phase 4b — OpenClaw Architecture Extension ✅ Complete
- [x] **Config schema** extended with `agents`, `sandbox`, `canvas`, `companion` sections.
- [x] **Manifest schema** extended with `sandbox` and `compose` fields, `composed` adapter.
- [x] **BaseChannel abstraction** — unified `ChannelAdapter` interface for all channels.
- [x] **New channels**: WebSocket WebChat (`WebchatChannel`), generic HTTP Webhook (`WebhookChannel`).
- [x] **ControlPlane** — typed event bus (`EventBus`) + agent pool (`AgentPool`) + control plane orchestrator.
- [x] **Multi-agent routing** — `AgentRouter` maps `(channelType, accountId, peerId) → agentId`.
- [x] **AgentInstance** — isolated engine per agent with separate workspace, registry, router, executor, sessions.
- [x] **DM Security Policy** — `pairing` mode (default): unknown senders receive pairing code challenge; `open` mode for public bots.
- [x] **Pairing store** — persisted paired peers in `~/.agentoctopus/pairing.json` with 10-min expiring codes.
- [x] **Sandbox adapters** — `DockerAdapter` (container isolation), `SshAdapter` (remote execution), `OpenShellAdapter` (local pass-through).
- [x] **SkillComposer** — executes `compose` DAGs with input/output mapping, conditional branching, and result synthesis.
- [x] **Composition validation** — `validateComposition()` checks inputMapping references and `detectCycles()` guards self-references.

### Phase 5 — Developer Ecosystem ✅ Complete
- [x] Web UI: enhanced chat interface with skills sidebar, dark/light mode, conversation clear, marketplace link.
- [x] Public skill marketplace / registry — own REST API (list, search, publish, install) with web browse UI.
- [x] SDK for publishing community skills — `octopus publish` CLI command reads SKILL.md and publishes to marketplace.

### Phase 6 — Onboarding & Cloud Security ✅ Complete
- [x] Interactive setup wizard (`octopus onboard`) — 5-step guided configuration.
- [x] Auto-detect: `octopus ask`/`start` triggers onboard if `.env` is missing.
- [x] API key authentication middleware — file-based key store with tier management.
- [x] Sliding-window rate limiter — tier-aware (free/pro/enterprise) with standard headers.
- [x] Audit logger — structured JSONL logging of all gateway requests.
- [x] Self-service key registration endpoint (`POST /agent/register`).
- [x] CORS configuration and admin key management endpoints.

### Phase 6b — Gateway Control Plane ✅ Complete
- [x] `EventBus` — typed pub/sub for `message-received`, `skill-executed`, `feedback-recorded`, `session-created/expired` events.
- [x] `ControlPlane` — singleton orchestrator: starts agents, registers channels, routes events.
- [x] Per-agent workspace isolation: `~/.agentoctopus/agents/<id>/workspace/skills/`.
- [x] `getControlPlane()` / `resetControlPlane()` singleton pattern.

### Phase 8 — Bundled Skills & Skill Authoring ✅ Complete
- [x] Four built-in skills (weather, translation, ip-lookup, x-search) bundled inside `@agentoctopus/cli` and copied to `~/.agentoctopus/skills/` during `octopus onboard`.
- [x] `octopus onboard` Step 0 copies bundled skills before LLM/env config steps.
- [x] Credential prompts for skills that require API keys (x-search → `XAI_API_KEY`); stored in `~/.agentoctopus/octopus.json`.
- [x] `bootstrap()` reads skills directory and config from `~/.agentoctopus/octopus.json`.
- [x] `octopus skill create` — AI-assisted wizard: Q&A → LLM-generated `SKILL.md` → review/regenerate/accept flow.
- [x] `octopus skill create --template` — blank scaffold (`SKILL.md` + `scripts/invoke.js`) with no prompts.
- [x] `octopus skill list` alias for `octopus list`.

### Phase 7 — Payment & Billing (Planned)
- [ ] Cloudflare Tunnel for HTTPS on cloud gateway.
- [ ] Stripe integration for Pro/Enterprise subscriptions.
- [ ] 支付宝/微信支付 integration for Chinese users.
- [ ] Billing dashboard and `octopus billing` CLI command.
- [ ] Webhook handlers for subscription lifecycle events.

### Phase 15 — Live Canvas & Companion Apps (Planned)
- [ ] `CanvasServer` — WebSocket upgrade handler for A2UI rendering.
- [ ] `CanvasView` React component — renders agent-driven visual workspace.
- [ ] `CompanionServer` — WebSocket server on port 3003 for macOS/iOS/Android nodes.
- [ ] Device pairing with QR/code exchange.
- [ ] Node capability registry and compute offload routing.

### Phase 9 — Update & Debug ✅ Complete
- [x] `octopus update --check` — display installed vs. latest versions for all @agentoctopus packages.
- [x] `octopus sync --check` — check for skill updates without installing.
- [x] `octopus sync --cloud-url <url>` — three-phase sync (version check → awesome install → cloud sync).
- [x] Debug mode (`--debug`) — inline routing internals, cosine scores, reranker I/O, timing.
- [x] Credential guidance — pre-execution (`requires.env`) and runtime error detection with LLM-generated setup guides.

### Phase 10 — CLI & Web UI Enhancements ⏳ Partial
- [x] `octopus agent list` — list all configured agents.
- [ ] `octopus agent create <name>` — create isolated agent workspace.
- [ ] `octopus agent switch <name>` — manage agents.
- [ ] `octopus channel add <type>` — bind channel to agent.
- [ ] `octopus sandbox enable/disable <skill>` — toggle sandbox per skill.
- [ ] `octopus compose <skill>` — run composed skill with step preview.
- [ ] Web UI `/agents` dashboard, `/canvas` viewer, `/channels` config, `/skills/composer` builder.

### Phase 11 — Skill Evolution ✅ Complete
- [x] `packages/skills/src/evolution/` — full evolution subsystem (analyzer, applier, collector, rollback, scheduler, types).
- [x] `octopus evolve --check` — show evolution status for all skills.
- [x] `octopus evolve --propose <skill>` — manually trigger LLM-driven analysis for a specific skill.
- [x] `octopus evolve --review` — review pending risky proposals.
- [x] `octopus evolve --log <skill>` — show snapshot history for a skill.
- [x] `octopus evolve --rollback <skill>` — roll back a skill to a snapshot.
- [x] Shadow-copy rollback system — safe rollback with monotonic snapshot sequence numbers.
- [x] Stale skill cold-sweep scheduler — auto-detect and propose fixes for underperforming skills.
- [x] Evolution opt-in question added to `octopus onboard` wizard.

### Phase 12 — OpenClaw Skill Routing & Feedback ✅ Complete
- [x] Routing accuracy — exact skill name match outranks compound names.
- [x] Keyword-only routing improvements — better skill selection when embedding keys are omitted.
- [x] Session context for follow-up queries — `prevSkill` boost and reranker context route follow-ups correctly.
- [x] ClawHub install spec extraction — extract install specs from `metadata.openclaw.install` format.
- [x] Subprocess adapter auto-chmod — scripts made executable before execution.
- [x] Reranker selection respected — router uses configured reranker model, not hardcoded default.

### Phase 13 — OpenClaw Architecture Extension ✅ Complete
- [x] Multi-agent configuration — multiple agents with separate workspaces, models, and skill registries.
- [x] Agent-specific skill isolation — skills scoped per agent workspace.
- [x] Webhook channel (`WebhookChannel`) — generic HTTP webhook adapter with secret verification.
- [x] WebSocket WebChat channel (`WebchatChannel`) — real-time WebSocket chat interface.
- [x] Docker sandbox execution — skills run in isolated Docker containers.
- [x] Skill composition — `compose` DAG with input/output mapping and conditional branching.
- [x] DM pairing policy — pairing mode (challenge unknown senders) and open mode.
- [x] ControlPlane event bus — typed pub/sub emitting `skill-executed`, `feedback-recorded`, `session-created/expired` events.
- [x] Planner structured output passing — multi-hop queries pass JSON between steps.
- [x] Planner composite step detection — composed skills recognized by planner.
- [x] All 12 Phase 13 tests verified and passing.

### Phase 14 — Binary Auto-Install ✅ Complete
- [x] Binary install detection — executor returns `binary_installable` when skill declares `requires.bins` and `metadata.openclaw.install`.
- [x] Interactive CLI install prompt — `octopus ask` shows 4 options: install now, always install, try next skill, never install.
- [x] Install preference persistence — `skills.installPrefs` saved to `~/.agentoctopus/octopus.json`.
- [x] REST API `autoInstall=true` — gateway auto-installs missing binaries when requested.
- [x] REST API `binary_installable` response — returns missing binaries and install specs.
- [x] Chat channel two-phase install — IM bots prompt for confirmation before installing.

### Phase S — Sandbox Security Matrix ✅ Complete (Tasks 1–7 + 5b)

Fail-closed skill execution: every skill runs in a sandbox backend selected at runtime via `selectBackend`. Backends probe their own privileges before ranking; a backend is admitted only when its post-probe `isolationLevel` meets `minIsolationLevel`. Default `auto` + `full` throws `NoFullBackendError` when no full backend is available — never a host fallback.

- [x] **Task 1** — Security harness (`packages/sandbox/tests/security/harness.ts`): `runArgv` (execFile, never shell), real capability probes (`probeDocker`, `probePrivilegedLinux`, `probeMacSandbox`), `HostCanary`, immutable-image ref verification (`requirePinnedImageRef`).
- [x] **Task 2** — Docker lane + sidecar topology: host-canary, direct-internet/metadata denial, env/caps hygiene, timeout/tree-kill, cgroup; sidecar internal network + read-only CA mount.
- [x] **Task 3** — Privileged Linux lane (CI-owned, `skipIf`-gated, `OCTOPUS_REQUIRE_PRIVILEGED_LINUX=1` zero-skip).
- [x] **Task 4 / 4b** — Egress proxy adversarial matrix (non-granted HTTP/CONNECT, redirect method+credential, response cap/framing/max-conn, raw-header smuggling, DNS private/rebinding, TLS MITM + IP SAN type 7) + MCP stdio e2e over the Plan 5 port contract.
- [x] **Task 5 / 5b** — Identity + snapshot integrity (grants, hardlink/special rejection, byte/path/mode/symlink tamper → `SNAPSHOT_MISMATCH`) + macOS restricted + fail-closed lane (`macos-restricted-lane.test.ts`, commit `15d6dc4`).
- [x] **Task 6** — Reproducible runtime + proxy images (local build, immutable digests, direct-argv runtime, self-contained proxy bundle).
- [x] **Task 7** — Security CI + release preflight/publish gate (`sandbox-security.yml`, reusable-workflow identity verification, immutable image IDs recorded and re-verified before npm publish).
- [x] **macOS restricted production backend** — NO-GO by the T5 feasibility gate (dyld shared cache → unfilterable `file-read-data` breakout on macOS 26.x). `spawnDarwinProcess`/`darwin-process.ts` never implemented. VM sandbox backend (separate plan) supersedes for full isolation. macOS is never `full`; restricted is explicit opt-in only.
- [x] **VM sandbox backend (libkrun)** — Tasks 1–20 complete (`docs/superpowers/plans/2026-07-29-vm-sandbox-backend.md`). `packages/sandbox-vm-native` ships the trusted computing base: `sandbox-vm-helper` (C, pinned 13-step TSI-disabled krun start sequence, R10 mass-close), `octopus-vm-init` (guest PID 1, CBOR launch-spec decode, 3-branch executable resolution), `vm-image-builder` (sealed read-only ext4, single-block-group for skill block images), `VmEngineImpl` (posix_spawn FD plumbing R9/R10). Producer scripts: `build-vm-rootfs.mjs` (mke2fs + double-build SHA-256 reproducibility, linux-arm64 + linux-x64), `vendor-libkrun.mjs` (libkrun v1.19.4 source-build + libkrunfw v5.5.0 prebuilt), `run-vm-gates.mjs` (G1 host-file-unreachable + G2 network-canary-unreachable → gate manifest), `sign-release-manifest.mjs` (Ed25519 detached signature). L3 (7) + L4 (9) escape-matrix tests run on the `vm-lane` CI job in `sandbox-security.yml`; the lane is fail-closed (assert-no-skipped-tests) — a missing TCB fails the job rather than silently skipping. The release chain is wired end to end: `produce-linux-artifacts` builds the full linux-x64 TCB + both guest rootfs arches (pinned+sha256-verified nodejs.org ARM64 node via `OCTOPUS_ROOTFS_NODE_ARM64`; each rootfs emitted as top-level `rootfs.img` and runtime `rootfs/<ref>`); `vm-lane` runs G1/G2 + signs the release manifest BEFORE the L3/L4 tests (macOS lane consumes only the linux-arm64 rootfs — no x64 fallback) and uploads `vm-tcb-darwin-arm64`; `privileged-linux` (the only KVM lane) qualifies + signs the linux-x64 TCB and uploads `vm-tcb-linux-x64-qualified`. Release Preflight's pack job downloads both qualified TCBs, fails closed on any missing file, and asserts the `@agentoctopus/sandbox-vm-native` tarball contains the full signed TCB for both platforms. The Ed25519 release trust-root public key is committed (`packages/sandbox/src/vm/release-key.ts`); the matching private seed lives only in the `OCTOPUS_VM_RELEASE_PRIVATE_KEY` CI secret, and seed-form secrets import via a PKCS8 DER wrap.

**Sandbox security suite count:** 111 tests (`packages/sandbox/tests/security/`): image-contract 6, docker-lane 8 (expand), docker-topology 2, harness 10, identity-lane 14 (expand), linux-lane 12, linux-topology 6, macos-restricted-lane 4, proxy-lane 30 (expand), publish-gate 14 (expand), vm-lane 7 + vm-escape-matrix 9 (skipIf-gated, CI-owned). 101 pass on a macOS host; 10 Docker-lane cases fail locally only because the immutable runtime image cannot be pulled locally (pre-existing Docker provisioning delta, zero on CI). The 16 VM-lane cases skip locally (no libkrun TCB) and run on the `vm-lane` CI job.

### Phase 7 — Payment & Billing (Planned)

---

## Verification Plan

### Automated Tests ✅

```bash
# Run all tests across all workspaces
pnpm test

# Sandbox security suite (scoped — 111 tests):
pnpm --filter @agentoctopus/sandbox exec vitest run tests/security
```

Per-package declared test counts (workspace, not CI-expanded):

| Package | Test files | Declared `it/test` |
|---|---|---|
| `packages/skills` | 20 | 140 |
| `packages/registry` | 7 | 49 |
| `packages/adapters` | 8 | 31 |
| `packages/core` | 23 | 176 |
| `packages/sandbox` | 51 | 404 (111 in the security suite) |
| `packages/sandbox-vm-native` | 3 | 21 (16 pass + 5 skip without OCTOPUS_VM_IMAGE_BUILDER) |
| `packages/gateway` | 1 | 11 |
| `apps/cli` | 6 | 57 |
| `apps/web` | 1 | 6 |
| **Total** | **118** | **883 declared** |

Counts are `it/test` declarations; `it.each` expands to more at runtime (the sandbox security suite expands to 111). The privileged Linux lane is CI-owned (zero-skip on the provisioned runner, skipped on macOS dev hosts).

### Manual CLI Verification (Phase 1 ✅)

```bash
pnpm install && pnpm build
node apps/cli/dist/index.js ask "translate hello to French"
# → { skill: "translation", result: "Bonjour" }
```

### Manual API Verification (Phase 2 ✅)

```bash
# Start the Next.js dev server
cd apps/web && pnpm dev

# Query via curl
curl -X POST http://localhost:3000/api/ask \
  -H 'Content-Type: application/json' \
  -d '{"query": "translate hello to French"}'

# Expected response:
# { "success": true, "skill": "translation", "confidence": 0.97, "response": "Bonjour" }
```
