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
│   ├── web/                    # Next.js web UI + REST API routes
│   │   ├── app/
│   │   │   ├── api/
│   │   │   │   ├── ask/route.ts          # POST /api/ask
│   │   │   │   ├── skills/route.ts       # GET/POST skill registry
│   │   │   │   └── feedback/route.ts     # POST /api/feedback (ratings)
│   │   │   └── page.tsx                  # Chat UI
│   │   └── package.json
│   │
│   └── cli/                    # CLI entry point (MVP)
│       ├── index.ts            # `octopus ask "..."` command
│       └── package.json
│
├── packages/
│   ├── core/
│   │   ├── router.ts           # Intent embedding + skill selection
│   │   ├── executor.ts         # Skill/MCP invocation engine
│   │   └── aggregator.ts       # Multi-result composition
│   │
│   ├── registry/
│   │   ├── registry.ts         # Load/search/CRUD for skill manifests
│   │   ├── manifest-schema.ts  # Zod schema for SKILL.md frontmatter
│   │   └── rating.ts           # Rating store (file-based → DB later)
│   │
│   ├── adapters/
│   │   ├── http-adapter.ts     # Generic REST skill adapter
│   │   ├── mcp-adapter.ts      # MCP SSE / stdio bridge
│   │   └── subprocess-adapter.ts # Local script execution
│   │
│   └── gateway/
│       ├── im/
│       │   ├── slack.ts        # Slack bot adapter
│       │   ├── discord.ts      # Discord bot adapter
│       │   └── telegram.ts     # Telegram bot adapter
│       └── agent-protocol.ts   # Agent-to-agent interface (OpenClaw etc.)
│
├── registry/
│   └── skills/                 # Built-in SKILL.md manifests
│       ├── web-search/SKILL.md
│       ├── translation/SKILL.md
│       └── code-runner/SKILL.md
│
└── tests/
    ├── router.test.ts
    ├── registry.test.ts
    └── executor.test.ts
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

### Phase 1 — CLI MVP ✅ Start Here
- [ ] Define `SKILL.md` manifest schema (Zod validation).
- [ ] Build the **Registry** — load manifests from `registry/skills/`, search by tags + description.
- [ ] Build the **Router** — embed skill descriptions with a local vector store (LanceDB / vectra), match user query, LLM re-rank.
- [ ] Build the **Executor** — call HTTP-based skills, return structured results.
- [ ] Build **`apps/cli`** — `octopus ask "..."` command that runs the full pipeline.
- [ ] Bundle 3 built-in skills (web search, translation, code execution).
- [ ] Add basic **rating collection** via CLI prompt after each response.

### Phase 2 — MCP Protocol & REST API
- [ ] `mcp-adapter.ts` — support MCP SSE and stdio transport.
- [ ] Remote MCP catalog discovery from a registry URL.
- [ ] `POST /api/ask` REST endpoint (Next.js API route).
- [ ] `POST /api/feedback` for rating updates.

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

### Automated Tests

```bash
# Run all tests
pnpm test

# Unit: router picks correct skill for sample prompts
pnpm test packages/core/router.test.ts

# Unit: registry loads manifests + validates schema
pnpm test packages/registry/registry.test.ts

# Integration: end-to-end CLI ask with mock skills
pnpm test tests/integration.test.ts
```

### Manual CLI Verification (Phase 1)

```bash
# Install
pnpm install && pnpm build

# Ask a question
node apps/cli/index.js ask "translate hello to French"
# Expected: { skill: "translation", result: "Bonjour" }

# Try unknown request
node apps/cli/index.js ask "book me a flight to Tokyo"
# Expected: graceful "No matching skill found" message

# Rate the result
# After each response: "Was this helpful? (y/n)"
# Verify rating updates in registry/ratings.json
```
