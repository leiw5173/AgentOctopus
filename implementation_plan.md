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
│   │   │   ├── executor.ts         # ✅ Skill/MCP invocation engine
│   │   │   └── llm-client.ts       # ✅ Pluggable LLM backend
│   │   └── tests/
│   │       ├── router.test.ts
│   │       ├── executor.test.ts
│   │       └── integration.test.ts  # ✅ End-to-end test
│   │
│   ├── registry/
│   │   ├── src/
│   │   │   ├── registry.ts         # ✅ Load/search/CRUD for skill manifests
│   │   │   ├── manifest-schema.ts  # ✅ Zod schema for SKILL.md frontmatter
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
│   │   │   └── subprocess-adapter.ts # ✅ Local script execution
│   │   └── tests/
│   │       └── mcp-adapter.test.ts  # ✅ MCP adapter tests
│   │
│   └── gateway/                    # ⏳ Planned Phase 3
│       ├── im/
│       │   ├── slack.ts
│       │   ├── discord.ts
│       │   └── telegram.ts
│       └── agent-protocol.ts
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

### Phase 3 — IM & Agent Input
- [ ] Slack / Discord / Telegram bot adapters.
- [ ] Agent-to-agent protocol (OpenClaw and similar).
- [ ] Stateful session management across turns.

### Phase 4 — Intelligence & Composition
- [ ] Multi-hop routing: decompose complex requests into sub-tasks.
- [ ] LLM planner that generates an execution DAG.
- [ ] Confidence scoring; graceful "no matching skill" message.

### Phase 5 — Developer Ecosystem
- [ ] Web UI: chat interface (`apps/web`).
- [ ] Public skill marketplace / registry.
- [ ] SDK for publishing community skills.

---

## Verification Plan

### Automated Tests ✅

```bash
# Run all tests across all workspaces
pnpm test

# Results (all green):
# packages/registry  — 9 tests  ✅
# packages/adapters  — 3 tests  ✅  (incl. mcp-adapter)
# packages/core      — 6 tests  ✅  (incl. integration)
# apps/cli           — 1 test   ✅
# apps/web           — 2 tests  ✅  (POST /api/ask)
```

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
