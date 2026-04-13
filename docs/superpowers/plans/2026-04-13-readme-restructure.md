# README Restructure Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Slim README.md to ~80 lines focused on skill users (OpenClaw/Claude Code/Hermes), and move all developer content into four focused docs under `docs/`.

**Architecture:** README becomes a platform-user landing page. Developer content (REST API, deployment, IM bots, architecture, configuration) moves verbatim into four self-contained docs that link back to each other where needed. No content is lost.

**Tech Stack:** Markdown only — no code changes.

---

## File Map

| Action | File | Responsibility |
|--------|------|----------------|
| Rewrite | `README.md` | Platform-user landing page: what it is, install as skill (OpenClaw/Claude Code/Hermes), bundled skills, add more skills, dev links |
| Create | `docs/DEPLOYMENT.md` | Docker, cloud/local modes, skill sync, deployment env vars, cloud gateway auth/rate-limiting/audit logging |
| Create | `docs/API.md` | REST API endpoints, feedback API, marketplace API, agent protocol (OpenClaw-compatible HTTP) |
| Create | `docs/INTEGRATIONS.md` | Slack/Discord/Telegram bots, multi-hop planner, npm packages table, creating skills (wizard + manual) |
| Create | `docs/ARCHITECTURE.md` | Folder tree, package responsibilities, configuration env vars (.env reference), user home directory |

---

### Task 1: Create `docs/DEPLOYMENT.md`

**Files:**
- Create: `docs/DEPLOYMENT.md`

- [ ] **Step 1: Create the file with all deployment content from README**

Create `docs/DEPLOYMENT.md` with this exact content:

```markdown
# Deployment

AgentOctopus supports two deployment modes: **cloud** (centralized server for all users) and **local** (self-hosted, free, with skill sync from cloud).

## Docker (recommended)

```bash
# Cloud deployment — gateway + web UI
docker compose --profile cloud up --build
# → Gateway on http://localhost:3002, Web UI on http://localhost:3000

# Local deployment — gateway only, syncs skills from cloud
CLOUD_URL=https://your-cloud-instance:3002 docker compose --profile local up --build
# → Gateway on http://localhost:3002
```

## Cloud mode

Runs the full gateway + web UI. All skills are served and available for local instances to sync from.

```bash
DEPLOY_MODE=cloud AGENT_GATEWAY_PORT=3002 agentoctopus-gateway
```

## Local mode

Runs the gateway only. Optionally syncs skills from a cloud instance on startup.

```bash
# With auto-sync from cloud
DEPLOY_MODE=local CLOUD_URL=https://cloud:3002 agentoctopus-gateway

# Manual sync via CLI
octopus sync --cloud-url https://cloud:3002

# Manual sync via API
curl -X POST http://localhost:3002/agent/sync \
  -H 'Content-Type: application/json' \
  -d '{"cloudUrl": "https://cloud:3002"}'
```

## Skill sync

Local instances can pull skills from a cloud instance:

- **On startup**: set `CLOUD_URL` env var (enabled by default, disable with `SYNC_ON_STARTUP=false`)
- **On demand**: `POST /agent/sync` or `octopus sync --cloud-url <url>`
- **Force update**: use `--force` flag or `{"force": true}` to overwrite existing skills

The cloud instance exposes `GET /agent/skills/export` which returns full skill data (SKILL.md + scripts) for sync.

## Environment variables

| Variable | Default | Description |
|----------|---------|-------------|
| `DEPLOY_MODE` | `local` | `cloud` or `local` |
| `CLOUD_URL` | — | Cloud instance URL for skill sync |
| `SYNC_ON_STARTUP` | `true` | Auto-sync on gateway boot |
| `AGENT_GATEWAY_PORT` | `3002` | Gateway listen port |

## Cloud Gateway Security

The agent gateway (`/agent/*` endpoints) includes built-in security for production deployment.

### API Key Authentication

All authenticated endpoints require an API key:

```bash
# Register for a free API key
curl -X POST https://your-gateway/agent/register \
  -H 'Content-Type: application/json' \
  -d '{"email": "you@example.com"}'
# → { "apiKey": "ak_...", "tier": "free", "limits": { ... } }

# Use the key in requests
curl -X POST https://your-gateway/agent/ask \
  -H 'Content-Type: application/json' \
  -H 'Authorization: Bearer ak_...' \
  -d '{"query": "translate hello to French"}'
```

Keys can also be passed via `X-API-Key` header or `?apiKey=` query parameter.

### Rate Limiting

Tier-based sliding-window rate limiting with standard headers:

| Tier | Requests/min | Requests/day | Price |
|------|-------------|-------------|-------|
| Free | 10 | 100 | $0/mo |
| Pro | 60 | 5,000 | $19/mo |
| Enterprise | 300 | 50,000 | $99/mo |

Response headers: `X-RateLimit-Limit`, `X-RateLimit-Remaining`, `X-RateLimit-Reset`.

### Audit Logging

All requests are logged to `logs/audit.jsonl` with:
- Timestamp, HTTP method, path, IP address
- Masked API key, user ID, tier
- Status code, response time, query content

### Security environment variables

| Variable | Default | Description |
|---|---|---|
| `AUTH_ENABLED` | `true` | Enable/disable API key authentication |
| `RATE_LIMIT_ENABLED` | `true` | Enable/disable rate limiting |
| `CORS_ALLOWED_ORIGINS` | `*` | Comma-separated allowed origins |
| `API_KEYS_PATH` | `./api-keys.json` | Path to API keys store |
| `AUDIT_LOG_DIR` | `./logs` | Directory for audit log files |
```

- [ ] **Step 2: Commit**

```bash
git add docs/DEPLOYMENT.md
git commit -m "docs: add DEPLOYMENT.md (moved from README)"
```

---

### Task 2: Create `docs/API.md`

**Files:**
- Create: `docs/API.md`

- [ ] **Step 1: Create the file with all REST/API content from README**

Create `docs/API.md` with this exact content:

```markdown
# REST API

Start the gateway and call the API:

```bash
octopus start
```

## Endpoints

### Route a query

```bash
curl -X POST http://localhost:3002/agent/ask \
  -H 'Content-Type: application/json' \
  -d '{"query": "translate hello to French"}'
# → { "success": true, "skill": "translation", "confidence": 0.97, "response": "Bonjour" }
```

### Submit feedback

```bash
curl -X POST http://localhost:3000/api/feedback \
  -H 'Content-Type: application/json' \
  -d '{"skillName": "translation", "positive": true}'
```

### List installed skills

```bash
curl http://localhost:3000/api/skills
# → { "skills": [{ "name": "translation", "rating": 4.5, ... }] }
```

### Search the marketplace

```bash
curl http://localhost:3000/api/marketplace?q=weather
# → { "skills": [...], "total": 1 }
```

### Publish a skill to the marketplace

```bash
curl -X POST http://localhost:3000/api/marketplace \
  -H 'Content-Type: application/json' \
  -d '{"slug": "my-skill", "name": "My Skill", "description": "...", "author": "me", "skillMd": "---\nname: my-skill\n..."}'
```

### Install a skill from the marketplace

```bash
curl -X POST http://localhost:3000/api/marketplace/install \
  -H 'Content-Type: application/json' \
  -d '{"slug": "my-skill"}'
```

## Agent Protocol (OpenClaw-compatible)

AgentOctopus provides an OpenClaw-compatible HTTP API for agent-to-agent communication. External agents can route queries to specialized skills, maintain sessions, and receive direct LLM answers when no skill matches.

### Quick Start

```bash
# Install and run
npx @agentoctopus/gateway

# Or install globally
npm install -g @agentoctopus/gateway
agentoctopus-gateway
```

### Basic Usage

```bash
# Route a query with agent identity
curl -X POST http://localhost:3002/agent/ask \
  -H 'Content-Type: application/json' \
  -d '{"query": "translate hello to French", "agentId": "openclaw"}'
```

For complete integration guide including deployment options, examples, and troubleshooting, see [DEPLOYMENT.md](./DEPLOYMENT.md).
```

- [ ] **Step 2: Commit**

```bash
git add docs/API.md
git commit -m "docs: add API.md (moved from README)"
```

---

### Task 3: Create `docs/INTEGRATIONS.md`

**Files:**
- Create: `docs/INTEGRATIONS.md`

- [ ] **Step 1: Create the file with IM bot, planner, npm, and skill creation content**

Create `docs/INTEGRATIONS.md` with this exact content:

```markdown
# Integrations

## npm Packages

| Package | Description |
|---|---|
| [`agentoctopus`](https://www.npmjs.com/package/agentoctopus) | All-in-one install — includes everything below |
| [`@agentoctopus/cli`](https://www.npmjs.com/package/@agentoctopus/cli) | CLI (`octopus ask`, `list`, `add`, `search`, `publish`) |
| [`@agentoctopus/core`](https://www.npmjs.com/package/@agentoctopus/core) | Router, Executor, LLM client |
| [`@agentoctopus/gateway`](https://www.npmjs.com/package/@agentoctopus/gateway) | Slack/Discord/Telegram bots, agent HTTP API |
| [`@agentoctopus/registry`](https://www.npmjs.com/package/@agentoctopus/registry) | Skill manifest loader, rating store |
| [`@agentoctopus/adapters`](https://www.npmjs.com/package/@agentoctopus/adapters) | HTTP, MCP, subprocess adapters |

Install individual packages if you only need a subset:

```bash
npm install @agentoctopus/gateway   # IM bots + agent protocol
npm install @agentoctopus/core      # router + executor + LLM client
npm install @agentoctopus/cli       # CLI only
```

## IM Bots

Each platform adapter bootstraps the same routing engine and maintains per-user sessions (30-minute TTL, last 50 messages).

### Slack

```ts
import { startSlackGateway } from 'agentoctopus';

await startSlackGateway({
  appOptions: {
    token: process.env.SLACK_BOT_TOKEN,
    signingSecret: process.env.SLACK_SIGNING_SECRET,
    socketMode: true,
    appToken: process.env.SLACK_APP_TOKEN,
  },
});
// Responds to @mentions and direct messages
```

### Discord

```ts
import { startDiscordGateway } from 'agentoctopus';

await startDiscordGateway({ token: process.env.DISCORD_TOKEN });
// Responds to @mentions in guilds and all DMs
```

### Telegram

```ts
import { startTelegramGateway } from 'agentoctopus';

await startTelegramGateway({ token: process.env.TELEGRAM_BOT_TOKEN });
// /ask <request>  or plain text messages
```

## Multi-hop Planner

For complex queries that involve multiple skills, the Planner decomposes the request into sub-tasks, runs them in parallel (or sequentially if there are dependencies), and synthesizes a single answer:

```ts
import { Planner, Router, Executor, SkillRegistry, createChatClient, createEmbedClient } from 'agentoctopus';

// ... set up registry, router, executor as usual ...

const planner = new Planner(chatClient, router, executor);
const result = await planner.run(
  'translate hello to French and check the weather in Paris',
  registry.getAll(),
);

console.log(result.finalAnswer);
// → "Bonjour! The weather in Paris is 22°C and sunny."

console.log(result.plan.isMultiHop);     // true
console.log(result.stepResults.length);  // 2
result.stepResults.forEach(s => {
  console.log(`${s.skill || 'LLM'}: ${s.output} (confidence: ${s.confidence})`);
});
```

Steps without dependencies run in parallel. When a step depends on a prior step's output, it waits and receives the context automatically.

## Creating Skills

### AI-assisted wizard

```bash
octopus skill create
```

Walks you through a short Q&A, then uses your configured LLM to generate a `SKILL.md` manifest. You can review, regenerate with notes, or fall back to a template. For API-based skills it also writes a `scripts/invoke.js` stub.

### Template scaffold

```bash
octopus skill create --template
```

Writes a blank `SKILL.md` and `scripts/invoke.js` immediately — no prompts, no AI. Fill them in manually.

### Manual SKILL.md

Create a new folder under `registry/skills/<skill-name>/` with a `SKILL.md`:

```markdown
---
name: my-skill
description: What this skill does and when to use it.
tags: [tag1, tag2]
version: 1.0.0
endpoint: https://api.example.com/invoke
adapter: http
---

## Instructions
...
```

### Publishing to the marketplace

```bash
cd my-skill/    # folder containing SKILL.md
octopus publish --author "your-name"
# → Published to the marketplace at http://localhost:3000/marketplace
```

Users browse `/marketplace`, click Install, restart the server — the skill is then available for routing queries.
```

- [ ] **Step 2: Commit**

```bash
git add docs/INTEGRATIONS.md
git commit -m "docs: add INTEGRATIONS.md (moved from README)"
```

---

### Task 4: Create `docs/ARCHITECTURE.md`

**Files:**
- Create: `docs/ARCHITECTURE.md`

- [ ] **Step 1: Create the file with architecture, config, and user home content**

Create `docs/ARCHITECTURE.md` with this exact content:

```markdown
# Architecture

## Package Structure

```
AgentOctopus/
├── apps/
│   ├── cli/           # CLI entry point (`octopus ask/list/add/publish/onboard`)
│   └── web/           # Next.js web UI, REST API, and marketplace
│       ├── /           # Chat interface with skills sidebar
│       └── /marketplace  # Skill marketplace browser
├── packages/
│   ├── agentoctopus/  # Umbrella package — re-exports everything
│   ├── core/          # Router + Executor + Planner + LLM client
│   ├── registry/      # Skill manifest loader + rating store + remote catalog
│   ├── adapters/      # HTTP, MCP stdio, subprocess adapters
│   └── gateway/       # IM bots + agent protocol + security middleware
│       ├── auth-middleware.ts   # API key authentication + tier management
│       ├── rate-limiter.ts      # Sliding-window rate limiting
│       └── audit-logger.ts      # Structured request logging (JSONL)
└── registry/
    ├── skills/        # Built-in SKILL.md manifests
    └── marketplace/   # Published skills + index.json
```

## Request Flow

```
User query
  → Gateway (CLI / REST API / IM bot / agent-protocol)
  → Router   — embeds query, cosine-scores against skill index,
               pre-filters with isSkillEligible(), LLM re-ranks,
               returns [] if no skill fits (→ direct LLM answer)
  → Executor — picks adapter (http / mcp / subprocess), invokes skill
  → Result   — formatted, returned to caller; feedback updates ratings.json
```

## Configuration

The easiest way to configure AgentOctopus is with the setup wizard:

```bash
octopus onboard
```

Or manually copy `.env.example` and fill in your values:

```bash
cp .env.example .env
```

```env
# LLM backend
LLM_PROVIDER=openai          # openai | gemini | ollama
LLM_MODEL=gpt-4o-mini
OPENAI_API_KEY=sk-...
OPENAI_BASE_URL=https://your-openai-compatible-base-url/v1

# Embeddings and reranking (optional — omit for LLM-only routing)
EMBED_PROVIDER=openai
EMBED_MODEL=text-embedding-3-small
EMBED_API_KEY=
EMBED_BASE_URL=https://your-embedding-base-url/v1
RERANK_MODEL=gpt-4o-mini

# Execution mode
EXECUTION_MODE=local         # local | cloud | hybrid
CLOUD_GATEWAY_URL=https://api.agentoctopus.dev
CLOUD_API_KEY=

# Optional alternate providers
GEMINI_API_KEY=
OLLAMA_BASE_URL=http://localhost:11434
OLLAMA_MODEL=llama3.2

# Registry paths (optional, defaults to ./registry/)
REGISTRY_PATH=./registry/skills
RATINGS_PATH=./registry/ratings.json

# IM bot tokens
SLACK_BOT_TOKEN=xoxb-...
SLACK_SIGNING_SECRET=...
SLACK_APP_TOKEN=xapp-...
DISCORD_TOKEN=...
TELEGRAM_BOT_TOKEN=...
```

General questions that do not match a registered skill fall back to the configured chat model directly. Embedding keys are optional — if omitted, the router uses LLM-only mode (all eligible skills go directly to LLM re-rank).

## User Home Directory

When you install `@agentoctopus/cli` globally and run `octopus onboard`, the wizard copies built-in skills to your chosen skills directory (default: `~/.agentoctopus/skills/`).

```
~/.agentoctopus/
  skills/          ← active skill registry (user-owned)
  ratings.json     ← persisted ratings
  octopus.json     ← machine-level config: skills dir path + API key credentials
```

To change the skills directory or update credentials, re-run `octopus onboard`.

## Test Coverage

| Package | Tests |
|---|---|
| `packages/registry` | 15 |
| `packages/adapters` | 3 |
| `packages/core` | 14 |
| `apps/cli` | 3 |
| `apps/web` | 6 |
| `packages/gateway` | 11 |
```

- [ ] **Step 2: Commit**

```bash
git add docs/ARCHITECTURE.md
git commit -m "docs: add ARCHITECTURE.md (moved from README)"
```

---

### Task 5: Rewrite `README.md`

**Files:**
- Modify: `README.md` (full rewrite)

- [ ] **Step 1: Replace README.md with the slim platform-user version**

Overwrite `README.md` with this exact content:

```markdown
# AgentOctopus

> Intelligent routing layer that connects user needs to Skills — install once, works everywhere.

Users express their intent in plain language. AgentOctopus automatically selects, invokes, and returns results from the best-matching skill.

```
User: "Translate hello to French"
        │
        ▼
  AgentOctopus  ←  intent routing + rating-aware selection
        │
        ▼
  Translation Skill
        │
        ▼
  "Bonjour"
```

## Use as a Skill

### OpenClaw

Install AgentOctopus as a skill from [ClaWHub](https://clawhub.ai):

```bash
clawhub install agentoctopus
```

Import your OpenClaw LLM config (no re-entry of API keys):

```bash
octopus connect openclaw
```

OpenClaw will route queries to AgentOctopus via `octopus ask`. No server required.

**Updating:**

```bash
clawhub update agentoctopus
npm update -g agentoctopus
octopus connect openclaw   # re-run to refresh config
```

### Claude Code

Add AgentOctopus as an MCP tool in your Claude Code settings:

```bash
# Install globally
npm install -g agentoctopus

# Register as MCP server (in your Claude Code MCP config)
{
  "mcpServers": {
    "agentoctopus": {
      "command": "octopus",
      "args": ["mcp"]
    }
  }
}
```

Claude Code will now route tool calls through AgentOctopus for skill-backed answers.

### Hermes

Install via npm and point Hermes at the gateway:

```bash
npm install -g agentoctopus
octopus onboard       # configure your LLM provider
octopus start         # starts gateway on http://localhost:3002
```

Add AgentOctopus as a tool in your Hermes agent config:

```json
{
  "tools": [{
    "name": "agentoctopus",
    "endpoint": "http://localhost:3002/agent/ask",
    "description": "Routes queries to the best available skill"
  }]
}
```

## Bundled Skills

Installed automatically when you run `octopus onboard`:

| Skill | What it does | Requires |
|---|---|---|
| `weather` | Current weather for any city via wttr.in | Nothing |
| `translation` | Text translation via MyMemory API | Nothing |
| `ip-lookup` | IP/domain geolocation via ip-api.com | Nothing |
| `x-search` | Search X (Twitter) posts via xAI Grok API | `XAI_API_KEY` |

## Adding More Skills

```bash
# Install a single skill from ClaWHub
octopus add <slug>

# Bulk-install from the awesome-openclaw-skills curated list (5,000+ skills)
octopus sync-awesome

# Filter by category
octopus sync-awesome --category productivity
```

Browse the full curated list: [awesome-openclaw-skills](https://github.com/VoltAgent/awesome-openclaw-skills)

## Development

```bash
npm install -g agentoctopus
octopus onboard    # interactive setup wizard
octopus ask "translate hello to French"
octopus list       # show installed skills
```

From source:

```bash
pnpm install && pnpm build
pnpm test          # 40+ tests across 6 packages
```

## For Developers

- [docs/API.md](docs/API.md) — REST endpoints, marketplace API, agent protocol
- [docs/DEPLOYMENT.md](docs/DEPLOYMENT.md) — Docker, cloud/local modes, security, rate limiting
- [docs/INTEGRATIONS.md](docs/INTEGRATIONS.md) — Slack/Discord/Telegram bots, multi-hop planner, npm packages
- [docs/ARCHITECTURE.md](docs/ARCHITECTURE.md) — Package structure, configuration reference, `.env` vars

## License

Apache 2.0
```

- [ ] **Step 2: Verify line count ≤ 100**

```bash
wc -l README.md
```

Expected: ≤ 100 lines

- [ ] **Step 3: Commit**

```bash
git add README.md
git commit -m "docs: restructure README for skill-user audience, move dev content to docs/"
```

---

## Self-Review

**Spec coverage:**
- ✅ README ≤ 100 lines — Task 5 verifies with `wc -l`
- ✅ OpenClaw install steps — Task 5, "Use as a Skill → OpenClaw"
- ✅ Claude Code install steps — Task 5, "Use as a Skill → Claude Code" (written fresh)
- ✅ Hermes install steps — Task 5, "Use as a Skill → Hermes" (written fresh)
- ✅ Bundled skills table — Task 5
- ✅ `octopus add` + `octopus sync-awesome` — Task 5
- ✅ Deployment content → `docs/DEPLOYMENT.md` — Task 1
- ✅ REST API → `docs/API.md` — Task 2
- ✅ IM bots + planner + npm packages + creating skills → `docs/INTEGRATIONS.md` — Task 3
- ✅ Architecture + config env vars + user home → `docs/ARCHITECTURE.md` — Task 4
- ✅ Duplicate OpenClaw section (lines 212–236) removed — Task 5 (full rewrite)
- ✅ Each doc is self-contained with its own intro — all tasks

**Placeholder scan:** No TBDs, TODOs, or vague steps. All content is explicit.

**Type consistency:** Markdown only — no types or method signatures to check.
