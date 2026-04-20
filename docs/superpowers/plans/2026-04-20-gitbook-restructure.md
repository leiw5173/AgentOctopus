# GitBook Documentation Restructure — Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Reorganize AgentOctopus docs into GitBook-compatible structure with SUMMARY.md navigation, fill critical content gaps, fix outdated info, and add CI validation.

**Architecture:** Create `docs/SUMMARY.md` as navigation root. Move existing `docs/` content into subdirectories (introduction/, getting-started/, core-concepts/, integrations/, api-reference/, deployment/, contributing/). Write 10 new pages for gaps. Add `.gitbookignore` and CI workflow for link/format validation.

**Tech Stack:** Markdown, GitBook (SUMMARY.md), GitHub Actions (markdownlint, markdown-link-check)

---

## File Structure

### New files to create

```
docs/
  SUMMARY.md
  .gitbookignore
  README.md                          ← GitBook landing page
  introduction/
    what-is-agentoctopus.md
    key-features.md
    how-it-works.md
  getting-started/
    quick-start.md
    installation.md
    configuration.md
  core-concepts/
    routing.md
    skills.md
    ratings.md
    sessions.md
  integrations/
    openclaw.md
    claude-code.md
    hermes.md
    im-bots.md
    multi-hop.md
  api-reference/
    rest-api.md
    agent-protocol.md
    cli-reference.md
  deployment/
    docker.md
    cloud-local.md
    security.md
  contributing/
    adding-skills.md
    core-engine.md
    conventions.md
.github/workflows/docs-lint.yml
```

### Existing files to modify

```
README.md                            ← Trim to concise GitHub landing page
```

### Existing files to remove (content migrated)

```
docs/ARCHITECTURE.md                  ← Content split into introduction/ + core-concepts/
docs/API.md                          ← Content split into api-reference/
docs/DEPLOYMENT.md                   ← Content split into deployment/
docs/INTEGRATIONS.md                 ← Content split into integrations/
OPENCLAW_INTEGRATION.md              ← Content migrated to integrations/openclaw.md
CONTRIBUTING.md                      ← Content split into contributing/
```

---

### Task 1: Create directory structure and SUMMARY.md

**Files:**
- Create: `docs/SUMMARY.md`
- Create: `docs/README.md`
- Create: `docs/.gitbookignore`
- Create: all 22 subdirectory `.md` files (empty stubs)

- [ ] **Step 1: Create all directories**

```bash
mkdir -p docs/introduction docs/getting-started docs/core-concepts docs/integrations docs/api-reference docs/deployment docs/contributing
```

- [ ] **Step 2: Write SUMMARY.md**

Create `docs/SUMMARY.md`:

```markdown
# Table of contents

- [Introduction](introduction/what-is-agentoctopus.md)
  - [Key Features](introduction/key-features.md)
  - [How It Works](introduction/how-it-works.md)
- [Getting Started](getting-started/quick-start.md)
  - [Installation](getting-started/installation.md)
  - [Configuration](getting-started/configuration.md)
- [Core Concepts](core-concepts/routing.md)
  - [Skills](core-concepts/skills.md)
  - [Rating System](core-concepts/ratings.md)
  - [Sessions](core-concepts/sessions.md)
- [Integrations](integrations/openclaw.md)
  - [Claude Code](integrations/claude-code.md)
  - [Hermes](integrations/hermes.md)
  - [IM Bots](integrations/im-bots.md)
  - [Multi-hop Planner](integrations/multi-hop.md)
- [API Reference](api-reference/rest-api.md)
  - [Agent Protocol](api-reference/agent-protocol.md)
  - [CLI Reference](api-reference/cli-reference.md)
- [Deployment](deployment/docker.md)
  - [Cloud & Local Modes](deployment/cloud-local.md)
  - [Security](deployment/security.md)
- [Contributing](contributing/adding-skills.md)
  - [Core Engine](contributing/core-engine.md)
  - [Conventions](contributing/conventions.md)
```

- [ ] **Step 3: Write .gitbookignore**

Create `docs/.gitbookignore`:

```
superpowers/
../TEST_INSTRUCTIONS.md
../implementation_plan.md
../CLAUDE.md
../CODE_OF_CONDUCT.md
```

- [ ] **Step 4: Write GitBook landing page**

Create `docs/README.md`:

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

**Get started:** [Quick Start](getting-started/quick-start.md) | [Installation](getting-started/installation.md) | [Configuration](getting-started/configuration.md)

**Learn more:** [How It Works](introduction/how-it-works.md) | [Routing](core-concepts/routing.md) | [Skills](core-concepts/skills.md)
```

- [ ] **Step 5: Create stub files for all pages**

```bash
for f in \
  introduction/what-is-agentoctopus.md \
  introduction/key-features.md \
  introduction/how-it-works.md \
  getting-started/quick-start.md \
  getting-started/installation.md \
  getting-started/configuration.md \
  core-concepts/routing.md \
  core-concepts/skills.md \
  core-concepts/ratings.md \
  core-concepts/sessions.md \
  integrations/openclaw.md \
  integrations/claude-code.md \
  integrations/hermes.md \
  integrations/im-bots.md \
  integrations/multi-hop.md \
  api-reference/rest-api.md \
  api-reference/agent-protocol.md \
  api-reference/cli-reference.md \
  deployment/docker.md \
  deployment/cloud-local.md \
  deployment/security.md \
  contributing/adding-skills.md \
  contributing/core-engine.md \
  contributing/conventions.md; do
  touch "docs/$f"
done
```

- [ ] **Step 6: Commit**

```bash
git add docs/SUMMARY.md docs/README.md docs/.gitbookignore docs/introduction/ docs/getting-started/ docs/core-concepts/ docs/integrations/ docs/api-reference/ docs/deployment/ docs/contributing/
git commit -m "docs(structure): create GitBook directory layout and SUMMARY.md"
```

---

### Task 2: Write Introduction section

**Files:**
- Create: `docs/introduction/what-is-agentoctopus.md`
- Create: `docs/introduction/key-features.md`
- Create: `docs/introduction/how-it-works.md`

- [ ] **Step 1: Write what-is-agentoctopus.md**

Create `docs/introduction/what-is-agentoctopus.md`:

```markdown
# What is AgentOctopus?

AgentOctopus is an intelligent routing layer that connects natural-language requests to the best available skill. Users express their intent in plain language, and AgentOctopus automatically selects, invokes, and returns results from the most appropriate skill — no manual tool selection required.

## The problem it solves

AI agents and assistants need to call tools and APIs, but hard-coding every integration is fragile and doesn't scale. AgentOctopus provides a single entry point where:

- **Users** say what they want in plain language
- **AgentOctopus** figures out which skill handles it best
- **Skills** execute and return results

If no skill matches, the query falls back to a direct LLM answer — so nothing is lost.

## How it's different

| Approach | AgentOctopus |
|---|---|
| Hard-coded tool calls | Intent-based routing — add skills without changing caller code |
| Single LLM for everything | Specialized skills with rating-aware selection |
| Manual tool selection | Automatic: embedding similarity + LLM re-rank + rating scores |
| No quality feedback | 5-dimension rating system with auto-collected metrics |

See also: [Key Features](key-features.md) | [How It Works](how-it-works.md) | [Quick Start](../getting-started/quick-start.md)
```

- [ ] **Step 2: Write key-features.md**

Create `docs/introduction/key-features.md`:

```markdown
# Key Features

## Intent-based routing

Queries are embedded and compared against a skill index using cosine similarity. Top candidates are then re-ranked by an LLM to pick the best match. If no skill fits, the query gets a direct LLM answer.

## Multi-adapter skill execution

Skills can be invoked three ways:

- **HTTP adapter** — POST to an API endpoint
- **MCP adapter** — stdio-based Model Context Protocol
- **Subprocess adapter** — run a local Node.js script

## Rating-aware selection

Every skill is scored on 5 dimensions (completion, quality, reliability, latency, tokenCost) with task-type-aware weights. High-performing skills get boosted; failing skills get penalized. See [Rating System](../core-concepts/ratings.md).

## Multi-platform integrations

AgentOctopus works as:

- A **CLI** (`octopus ask`, `list`, `sync`)
- A **REST API** and **agent protocol** (OpenClaw-compatible)
- **IM bots** (Slack, Discord, Telegram)
- An **MCP server** for Claude Code
- A **tool** for Hermes agents

## Skill ecosystem

- 4 bundled skills (weather, translation, ip-lookup, x-search)
- 5,000+ community skills via `octopus sync` from ClaWHub
- AI-assisted skill creation with `octopus skill create`
- Marketplace for publishing and discovering skills

## Session management

Per-user sessions with 30-minute TTL and 50-message history. Supports follow-up queries in context. See [Sessions](../core-concepts/sessions.md).

See also: [How It Works](how-it-works.md) | [Routing](../core-concepts/routing.md)
```

- [ ] **Step 3: Write how-it-works.md**

Create `docs/introduction/how-it-works.md`:

```markdown
# How It Works

AgentOctopus processes every query through a multi-stage pipeline that goes from natural language to a skill result.

## Request flow

```
User query
  → Gateway (CLI / REST API / IM bot / agent-protocol)
  → Router   — translates non-English, extracts intent,
               embeds query, cosine-scores against skill index,
               pre-filters with isSkillEligible(),
               LLM re-ranks, returns [] if no skill fits
  → Executor — validates env vars, picks adapter (http / mcp / subprocess), invokes skill
  → Result   — formatted, returned to caller; feedback updates ratings
```

## Routing stages

1. **Language detection** — non-English queries are auto-translated to English for routing, then the original query is preserved for skill execution
2. **Intent extraction** — the LLM distills the query to a short intent phrase (e.g., "shorten a URL") so embeddings match purpose, not noise
3. **Eligibility filtering** — `isSkillEligible()` applies hard keyword filters (e.g., ip-lookup only activates when the query contains an IP address or domain)
4. **Embedding + cosine similarity** — the intent is embedded and compared against the skill index; scores are weighted by `routingScore`
5. **Keyword boost** — skills whose names match query tokens get boosted even if cosine similarity missed them
6. **LLM re-rank** — top candidates are sent to the LLM for final selection; "none" is a valid answer
7. **Fallback** — if no skill matches, the query goes to the configured chat model directly

## Package structure

```
AgentOctopus/
├── apps/
│   ├── cli/           # CLI entry point
│   └── web/           # Next.js web UI + REST API
├── packages/
│   ├── agentoctopus/  # Umbrella package — re-exports everything
│   ├── core/          # Router + Executor + Planner + LLM client
│   ├── registry/      # Skill manifest loader + rating store
│   ├── adapters/      # HTTP, MCP stdio, subprocess adapters
│   └── gateway/       # IM bots + agent protocol + security
├── scripts/
│   └── build-skills-index.js   # Daily index builder
└── registry/
    ├── skills/        # Built-in SKILL.md manifests
    └── marketplace/   # Published skills + index.json
```

See also: [Routing](../core-concepts/routing.md) | [Skills](../core-concepts/skills.md) | [API Reference](../api-reference/rest-api.md)
```

- [ ] **Step 4: Commit**

```bash
git add docs/introduction/
git commit -m "docs(introduction): write What is AgentOctopus, Key Features, How It Works"
```

---

### Task 3: Write Getting Started section

**Files:**
- Create: `docs/getting-started/quick-start.md`
- Create: `docs/getting-started/installation.md`
- Create: `docs/getting-started/configuration.md`

- [ ] **Step 1: Write quick-start.md**

Create `docs/getting-started/quick-start.md`:

```markdown
# Quick Start

Get AgentOctopus running in 5 minutes.

## 1. Install

```bash
npm install -g agentoctopus
```

## 2. Configure

```bash
octopus onboard
```

The interactive wizard will:
- Ask for your LLM provider and API key
- Set up embedding for skill routing
- Copy built-in skills to `~/.agentoctopus/skills/`

## 3. Use

```bash
octopus ask "what's the weather in Tokyo"
octopus ask "translate hello to French"
octopus list
```

## Next steps

- [Add more skills](../core-concepts/skills.md) from the 5,000+ community catalog
- [Configure integrations](../integrations/openclaw.md) with OpenClaw, Claude Code, or Hermes
- [Deploy the gateway](../deployment/docker.md) for API access
- [Understand routing](../core-concepts/routing.md) to tune skill selection
```

- [ ] **Step 2: Write installation.md**

Create `docs/getting-started/installation.md`:

```markdown
# Installation

## npm (recommended)

```bash
npm install -g agentoctopus
```

This installs the CLI (`octopus`) and all packages.

## Individual packages

```bash
npm install -g @agentoctopus/cli       # CLI only
npm install -g @agentoctopus/gateway   # IM bots + agent protocol
npm install -g @agentoctopus/core      # Router + executor + LLM client
```

## From source

```bash
git clone https://github.com/leiw5173/AgentOctopus.git
cd AgentOctopus
pnpm install
pnpm build
```

## Docker

```bash
docker compose --profile local up --build
```

See [Docker deployment](../deployment/docker.md) for cloud mode and configuration options.

## Verify installation

```bash
octopus list
# Should show: weather, translation, ip-lookup, x-search
```

## Requirements

- **Node.js 22+** for CLI and gateway
- **pnpm** for building from source (`npm install -g pnpm`)

See also: [Configuration](configuration.md) | [Quick Start](quick-start.md)
```

- [ ] **Step 3: Write configuration.md**

Create `docs/getting-started/configuration.md`:

```markdown
# Configuration

## Setup wizard

The easiest way to configure AgentOctopus:

```bash
octopus onboard
```

The wizard copies built-in skills to `~/.agentoctopus/skills/` and writes credentials to `~/.agentoctopus/octopus.json`.

## Environment variables

Copy `.env.example` and fill in your values:

```bash
cp .env.example .env
```

### LLM backend

| Variable | Default | Description |
|---|---|---|
| `LLM_PROVIDER` | `openai` | `openai`, `gemini`, or `ollama` |
| `LLM_MODEL` | `gpt-4o` | Chat model for re-ranking and direct answers |
| `OPENAI_API_KEY` | — | OpenAI API key |
| `OPENAI_BASE_URL` | — | OpenAI-compatible base URL (for proxies) |
| `GEMINI_API_KEY` | — | Google Gemini API key |
| `OLLAMA_BASE_URL` | `http://localhost:11434` | Ollama server URL |
| `OLLAMA_MODEL` | `llama3.2` | Ollama model name |

### Embeddings and reranking

Optional — omit for LLM-only routing (all eligible skills go directly to LLM re-rank).

| Variable | Default | Description |
|---|---|---|
| `EMBED_PROVIDER` | — | `openai`, `gemini`, or `ollama` |
| `EMBED_MODEL` | `text-embedding-3-small` | Embedding model |
| `EMBED_API_KEY` | — | API key for embedding provider |
| `EMBED_BASE_URL` | — | Base URL for embedding provider |
| `RERANK_MODEL` | `gpt-4o-mini` | Chat model for LLM re-ranking |

### Execution mode

| Variable | Default | Description |
|---|---|---|
| `DEPLOY_MODE` | `local` | `local` or `cloud` |
| `CLOUD_URL` | — | Cloud instance URL for skill sync |
| `SYNC_ON_STARTUP` | `true` | Auto-sync skills from cloud on gateway boot |
| `AGENT_GATEWAY_PORT` | `3002` | Gateway listen port |
| `OCTOPUS_ROOT` | `process.cwd()` | Project root directory |

### Registry paths

| Variable | Default | Description |
|---|---|---|
| `REGISTRY_PATH` | `./registry/skills` | Path to skills directory |
| `RATINGS_PATH` | `./registry/ratings.json` | Path to ratings file |

### IM bot tokens

| Variable | Description |
|---|---|
| `SLACK_BOT_TOKEN` | Slack bot token (`xoxb-...`) |
| `SLACK_SIGNING_SECRET` | Slack signing secret |
| `SLACK_APP_TOKEN` | Slack app token for socket mode (`xapp-...`) |
| `SLACK_PORT` | Slack gateway port (default: 3001) |
| `DISCORD_TOKEN` | Discord bot token |
| `TELEGRAM_BOT_TOKEN` | Telegram bot token |

### Security

| Variable | Default | Description |
|---|---|---|
| `AUTH_ENABLED` | `true` | Enable API key authentication |
| `RATE_LIMIT_ENABLED` | `true` | Enable rate limiting |
| `CORS_ALLOWED_ORIGINS` | `*` | Comma-separated allowed origins |
| `API_KEYS_PATH` | `./api-keys.json` | Path to API keys store |
| `AUDIT_LOG_DIR` | `./logs` | Directory for audit log files |

### Other

| Variable | Description |
|---|---|
| `GITHUB_TOKEN` | GitHub token for rating sync via Gist |
| `NODE_ENV` | `production` suppresses audit log detail |

## Managing credentials

```bash
# Set a credential
octopus config set COMMONS_API_KEY abc123

# List all credentials (values masked)
octopus config list

# Re-run full setup
octopus onboard
```

## User home directory

```
~/.agentoctopus/
  skills/          ← active skill registry (user-owned)
  ratings.json     ← persisted ratings
  octopus.json     ← machine-level config: skills dir path + API key credentials
```

See also: [Quick Start](quick-start.md) | [Deployment](../deployment/docker.md)
```

- [ ] **Step 4: Commit**

```bash
git add docs/getting-started/
git commit -m "docs(getting-started): write Quick Start, Installation, Configuration"
```

---

### Task 4: Write Core Concepts section

**Files:**
- Create: `docs/core-concepts/routing.md`
- Create: `docs/core-concepts/skills.md`
- Create: `docs/core-concepts/ratings.md`
- Create: `docs/core-concepts/sessions.md`

- [ ] **Step 1: Write routing.md**

Create `docs/core-concepts/routing.md`:

```markdown
# How Routing Works

AgentOctopus routes natural-language queries to the best-matching skill through a multi-stage pipeline.

## Pipeline

```
Query → Language detection → Intent extraction → Eligibility filter → Embedding + Cosine → Keyword boost → LLM re-rank → Result or Fallback
```

### 1. Language detection

Non-English queries are auto-translated to English for routing accuracy. The original query is preserved for skill execution.

### 2. Intent extraction

The LLM distills the query to a short intent phrase (e.g., "shorten a URL", "get weather forecast"). This removes URLs, code snippets, and domain names so embeddings match purpose, not noise.

### 3. Eligibility filtering

`isSkillEligible()` applies hard keyword/regex filters per skill:

| Skill | Filter rule |
|---|---|
| `ip-lookup` | Query must contain an IPv4 address or domain name |
| `weather` | Query must contain weather keywords (weather, temperature, forecast, rain, etc.) |
| `translation` | Query must contain translate keywords or language names |
| All others | Pass through unconditionally |

### 4. Embedding + cosine similarity

The intent is embedded and compared against the skill index. Scores are weighted by `routingScore`:

```
score = cosine_similarity(query_embedding, skill_embedding) × routingScore - penalties
```

Penalties:
- **Negative feedback penalty** — skills with recent thumbs-down get demoted
- **Catch-all penalty** — skills with overly broad descriptions (e.g., "use for any request") get heavily penalized

### 5. Keyword boost

Skills whose names match query tokens get boosted into the candidate set even if cosine similarity missed them. Up to 5 name-matched skills are added.

### 6. LLM re-rank

Top candidates are sent to the LLM with a prompt that includes "none" as a valid answer. If "none" is returned or re-rank fails, `route()` returns an empty array.

### 7. Fallback

When `route()` returns `[]`, callers (web API, agent-protocol, IM bots) fall back to answering directly with the chat LLM.

## LLM-only mode

If embedding keys are omitted (`EMBED_PROVIDER`/`EMBED_API_KEY` not set), the router skips embedding entirely. All eligible skills go directly to LLM re-rank with keyword scoring.

See also: [Skills](skills.md) | [Rating System](ratings.md) | [How It Works](../introduction/how-it-works.md)
```

- [ ] **Step 2: Write skills.md**

Create `docs/core-concepts/skills.md`:

```markdown
# Skills

Skills are the building blocks of AgentOctopus. Each skill is a self-contained capability that can be automatically selected by the router.

## Skill anatomy

Every skill lives in `registry/skills/<name>/` and consists of:

- **`SKILL.md`** — gray-matter YAML frontmatter + markdown instructions for the LLM
- **`scripts/invoke.js`** (optional) — required when `adapter: subprocess`

### SKILL.md frontmatter

```yaml
---
name: my-skill
description: What this skill does and when to use it.
tags: [tag1, tag2]
version: 1.0.0
adapter: http | mcp | subprocess
endpoint: https://api.example.com/invoke  # for http adapter
---
```

Required fields: `name`, `description`, `adapter`, `tags`.

### Environment variable requirements

Skills that need API keys declare them in frontmatter:

```yaml
metadata:
  openclaw:
    env: ["COMMONS_API_KEY"]
    homepage: "https://example.com"
```

The executor checks these before invocation. Missing vars produce a clear error:

```
✘ Skill "agent-commons" requires environment variables that are not set:
  COMMONS_API_KEY  — get yours at https://agentcommons.net
Run: octopus config set COMMONS_API_KEY <your-key>
```

## Adapters

| Adapter | How it works | When to use |
|---|---|---|
| `http` | POST to an API endpoint | External REST APIs |
| `mcp` | stdio-based Model Context Protocol | MCP-compatible tools |
| `subprocess` | Run a local Node.js script | Local scripts, free APIs |

## Bundled skills

Installed automatically by `octopus onboard`:

| Skill | What it does | Adapter | Requires |
|---|---|---|---|
| `weather` | Current weather via wttr.in | subprocess | Nothing |
| `translation` | Text translation via MyMemory API | subprocess | Nothing |
| `ip-lookup` | IP/domain geolocation via ip-api.com | subprocess | Nothing |
| `x-search` | Search X (Twitter) via xAI Grok API | subprocess | `XAI_API_KEY` |

## Community skills

Available via `octopus sync` (5,000+ from ClaWHub):

| Skill | What it does | Requires |
|---|---|---|
| `agent-commons` | Shared reasoning layer for AI agents | `COMMONS_API_KEY` |
| `agent-team-orchestration` | Multi-agent team orchestration | Nothing |
| `agentdo` | Task queue for AI agents | `AGENTDO_API_KEY` |
| `agentgate` | API gateway for personal data | `AGENT_GATE_TOKEN` + `AGENT_GATE_URL` |
| `ai-tools-github-radar` | AI tooling and GitHub traction | Nothing |

## Adding skills

```bash
# Install from ClaWHub
octopus add <slug>

# Sync from community catalog
octopus sync

# Create a new skill
octopus skill create
```

See [Adding Skills](../contributing/adding-skills.md) for the full contribution guide.

See also: [Routing](routing.md) | [Rating System](ratings.md) | [Quick Start](../getting-started/quick-start.md)
```

- [ ] **Step 3: Write ratings.md**

Create `docs/core-concepts/ratings.md`:

```markdown
# Rating System

Every skill is evaluated on 5 dimensions. The router uses a composite score to prefer high-performing skills and penalize failing ones.

## Dimensions

| Dimension | Range | Type | Source |
|---|---|---|---|
| `completion` | 0–1 | Objective | Auto-collected success/failure count |
| `quality` | 0–5 | Subjective | EMA of user thumbs-up/down feedback |
| `reliability` | 0–1 | Objective | 1 − (error rate from auto-collected metrics) |
| `latency` | 0–1 | Objective | Normalized response speed (1.0 at 0ms, decays to 0.0 at 2000ms) |
| `tokenCost` | 0–1 | Objective | Cost efficiency (1.0 at 0 tokens, decays to 0.0 at 500 tokens) |

## Task-type weights

The router computes a composite `routingScore` (0–1) as a weighted average. Weights adapt by task type:

| Task type | completion | quality | reliability | latency | tokenCost |
|---|---|---|---|---|---|
| `one-shot` | 0.30 | 0.25 | 0.20 | 0.15 | 0.10 |
| `long-running` | 0.25 | 0.20 | 0.30 | 0.10 | 0.15 |
| `agent-collab` | 0.20 | 0.30 | 0.25 | 0.10 | 0.15 |

- **one-shot** — completion and quality matter most
- **long-running** — reliability is weighted highest (crashes are costly)
- **agent-collab** — quality is weighted highest (output feeds other agents)

## Scoring formula

```
routingScore = w_completion × completion
             + w_quality × (quality / 5)
             + w_reliability × reliability
             + w_latency × latency
             + w_tokenCost × tokenCost
```

Quality is normalized from 0–5 to 0–1 before weighting.

## Feedback sources

- **CLI** — thumbs up/down after `octopus ask`
- **Web** — thumbs up/down in the chat UI
- **Agent platforms** — NLP keyword sentiment detection
- **Auto-collected** — success/failure counts, latency, token usage

Feedback uses exponential moving average (EMA) with weight 0.1 per event.

## Penalties

- **Negative feedback** — recent thumbs-down events apply a penalty to the routing score
- **Catch-all detection** — skills with overly broad descriptions (e.g., "use for any request") get a heavy penalty to prevent them from dominating routing

## Rating sync

Share ratings across instances using GitHub Gist:

```bash
octopus sync --setup-gist     # first-time setup
octopus sync --ratings --pull # pull from cloud
octopus sync --ratings --push # push to cloud
octopus sync --ratings        # bidirectional
```

See also: [Routing](routing.md) | [Skills](skills.md) | [Configuration](../getting-started/configuration.md)
```

- [ ] **Step 4: Write sessions.md**

Create `docs/core-concepts/sessions.md`:

```markdown
# Sessions

AgentOctopus maintains per-user conversation sessions so follow-up queries can reference earlier context.

## Session model

- **Key**: `platform + channelId + userId`
- **TTL**: 30 minutes after last activity
- **History**: last 50 messages per session
- **Cleanup**: expired sessions are removed automatically

## Usage

Sessions are managed automatically. When a query includes a `sessionId`, the router continues that conversation. Without a session ID, a new session is created.

### CLI

```bash
octopus ask "what's the weather in Tokyo"
# → Returns response with sessionId

octopus ask "how about London" --session <sessionId>
# → Follow-up in same session
```

### API

```bash
# First query — creates session
curl -X POST http://localhost:3002/agent/ask \
  -H 'Content-Type: application/json' \
  -d '{"query": "what is the weather in Paris"}'
# → {"sessionId": "abc-123", ...}

# Follow-up in same session
curl -X POST http://localhost:3002/agent/ask \
  -H 'Content-Type: application/json' \
  -d '{"query": "how about London", "sessionId": "abc-123"}'
```

## IM bot sessions

Slack, Discord, and Telegram bots maintain sessions per user/channel automatically. No session ID management needed — the bot infers the session from the message context.

See also: [Routing](routing.md) | [REST API](../api-reference/rest-api.md) | [IM Bots](../integrations/im-bots.md)
```

- [ ] **Step 5: Commit**

```bash
git add docs/core-concepts/
git commit -m "docs(core-concepts): write Routing, Skills, Rating System, Sessions"
```

---

### Task 5: Write Integrations section

**Files:**
- Create: `docs/integrations/openclaw.md`
- Create: `docs/integrations/claude-code.md`
- Create: `docs/integrations/hermes.md`
- Create: `docs/integrations/im-bots.md`
- Create: `docs/integrations/multi-hop.md`

- [ ] **Step 1: Write openclaw.md**

Create `docs/integrations/openclaw.md`:

```markdown
# OpenClaw

AgentOctopus provides an OpenClaw-compatible HTTP API for agent-to-agent communication.

## Install as a skill

```bash
clawhub install agentoctopus
```

Import your OpenClaw LLM config (no re-entry of API keys):

```bash
octopus connect openclaw
```

OpenClaw will route queries to AgentOctopus via `octopus ask`. No server required.

## Updating

```bash
clawhub update agentoctopus
npm update -g agentoctopus
octopus connect openclaw   # re-run to refresh config
```

## API endpoints

### Route a query

```bash
curl -X POST http://localhost:3002/agent/ask \
  -H 'Content-Type: application/json' \
  -d '{"query": "translate hello to French", "agentId": "openclaw"}'
```

**Response (skill matched):**

```json
{
  "success": true,
  "response": "Bonjour",
  "skill": "translation",
  "sessionId": "abc-123",
  "confidence": 0.92
}
```

**Response (no skill match):**

```json
{
  "success": true,
  "response": "2+2 equals 4",
  "skill": null,
  "sessionId": "abc-123",
  "confidence": null
}
```

### Submit feedback

```bash
curl -X POST http://localhost:3002/agent/feedback \
  -H 'Content-Type: application/json' \
  -d '{"skillName": "weather", "positive": true, "comment": "Accurate and fast"}'
```

### Health check

```bash
curl http://localhost:3002/agent/health
# → {"status": "ok", "skills": 4}
```

## Session continuation

```bash
# First query
curl -X POST http://localhost:3002/agent/ask \
  -H 'Content-Type: application/json' \
  -d '{"query": "what is the weather in Paris", "agentId": "openclaw-main"}'
# Returns: {"sessionId": "abc-123", ...}

# Follow-up in same session
curl -X POST http://localhost:3002/agent/ask \
  -H 'Content-Type: application/json' \
  -d '{"query": "how about London", "sessionId": "abc-123"}'
```

## Python client

```python
import requests

class AgentOctopusClient:
    def __init__(self, base_url="http://localhost:3002"):
        self.base_url = base_url
        self.session_id = None

    def ask(self, query, agent_id="openclaw"):
        payload = {"query": query, "agentId": agent_id}
        if self.session_id:
            payload["sessionId"] = self.session_id
        response = requests.post(f"{self.base_url}/agent/ask", json=payload)
        data = response.json()
        if data.get("success"):
            self.session_id = data.get("sessionId")
        return data

    def feedback(self, skill_name, positive, comment=None):
        payload = {"skillName": skill_name, "positive": positive}
        if comment:
            payload["comment"] = comment
        return requests.post(f"{self.base_url}/agent/feedback", json=payload).json()
```

See also: [Agent Protocol](../api-reference/agent-protocol.md) | [Deployment](../deployment/docker.md) | [Sessions](../core-concepts/sessions.md)
```

- [ ] **Step 2: Write claude-code.md**

Create `docs/integrations/claude-code.md`:

```markdown
# Claude Code

Add AgentOctopus as an MCP tool in Claude Code to route tool calls through the skill system.

## Setup

```bash
# Install globally
npm install -g agentoctopus
```

Register as an MCP server in your Claude Code MCP config:

```json
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

## How it works

When Claude Code encounters a query that matches a skill, it calls AgentOctopus via the MCP protocol. AgentOctopus routes the query to the best-matching skill and returns the result.

If no skill matches, the query falls back to Claude Code's default behavior.

See also: [OpenClaw](openclaw.md) | [Hermes](hermes.md) | [Skills](../core-concepts/skills.md)
```

- [ ] **Step 3: Write hermes.md**

Create `docs/integrations/hermes.md`:

```markdown
# Hermes

Use AgentOctopus as a tool for Hermes agents via the gateway HTTP API.

## Setup

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

Hermes will send queries to the gateway, which routes them through the skill system and returns results.

See also: [OpenClaw](openclaw.md) | [Claude Code](claude-code.md) | [REST API](../api-reference/rest-api.md)
```

- [ ] **Step 4: Write im-bots.md**

Create `docs/integrations/im-bots.md`:

```markdown
# IM Bots

AgentOctopus provides built-in bots for Slack, Discord, and Telegram. Each bootstraps the same routing engine and maintains per-user sessions (30-minute TTL, last 50 messages).

## Slack

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

Required env vars: `SLACK_BOT_TOKEN`, `SLACK_SIGNING_SECRET`, `SLACK_APP_TOKEN`.

## Discord

```ts
import { startDiscordGateway } from 'agentoctopus';

await startDiscordGateway({ token: process.env.DISCORD_TOKEN });
// Responds to @mentions in guilds and all DMs
```

Required env var: `DISCORD_TOKEN`.

## Telegram

```ts
import { startTelegramGateway } from 'agentoctopus';

await startTelegramGateway({ token: process.env.TELEGRAM_BOT_TOKEN });
// /ask <request>  or plain text messages
```

Required env var: `TELEGRAM_BOT_TOKEN`.

## npm packages

| Package | Description |
|---|---|
| [`agentoctopus`](https://www.npmjs.com/package/agentoctopus) | All-in-one — includes everything below |
| [`@agentoctopus/gateway`](https://www.npmjs.com/package/@agentoctopus/gateway) | IM bots + agent HTTP API |
| [`@agentoctopus/core`](https://www.npmjs.com/package/@agentoctopus/core) | Router, Executor, LLM client |
| [`@agentoctopus/registry`](https://www.npmjs.com/package/@agentoctopus/registry) | Skill manifest loader, rating store |
| [`@agentoctopus/adapters`](https://www.npmjs.com/package/@agentoctopus/adapters) | HTTP, MCP, subprocess adapters |

See also: [Sessions](../core-concepts/sessions.md) | [Configuration](../getting-started/configuration.md)
```

- [ ] **Step 5: Write multi-hop.md**

Create `docs/integrations/multi-hop.md`:

```markdown
# Multi-hop Planner

For complex queries that involve multiple skills, the Planner decomposes the request into sub-tasks, runs them in parallel (or sequentially if there are dependencies), and synthesizes a single answer.

## Usage

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

## How it works

1. The LLM decomposes the query into sub-tasks
2. Steps without dependencies run in parallel
3. Steps that depend on a prior step's output wait and receive context automatically
4. Results are synthesized into a single answer

See also: [Routing](../core-concepts/routing.md) | [Skills](../core-concepts/skills.md)
```

- [ ] **Step 6: Commit**

```bash
git add docs/integrations/
git commit -m "docs(integrations): write OpenClaw, Claude Code, Hermes, IM Bots, Multi-hop"
```

---

### Task 6: Write API Reference section

**Files:**
- Create: `docs/api-reference/rest-api.md`
- Create: `docs/api-reference/agent-protocol.md`
- Create: `docs/api-reference/cli-reference.md`

- [ ] **Step 1: Write rest-api.md**

Create `docs/api-reference/rest-api.md`:

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

### Publish a skill

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

See also: [Agent Protocol](agent-protocol.md) | [CLI Reference](cli-reference.md) | [Security](../deployment/security.md)
```

- [ ] **Step 2: Write agent-protocol.md**

Create `docs/api-reference/agent-protocol.md`:

```markdown
# Agent Protocol

AgentOctopus provides an OpenClaw-compatible HTTP API for agent-to-agent communication. External agents can route queries to specialized skills, maintain sessions, and receive direct LLM answers when no skill matches.

## Quick start

```bash
# Install and run
npx @agentoctopus/gateway

# Or install globally
npm install -g @agentoctopus/gateway
agentoctopus-gateway
```

## Endpoints

### POST /agent/ask

Route a query to AgentOctopus.

**Request:**

```json
{
  "query": "what is the weather in Tokyo",
  "agentId": "my-openclaw-agent",
  "sessionId": "optional-session-id",
  "metadata": {}
}
```

**Parameters:**
- `query` (required) — the user's question or request
- `agentId` (optional) — identifier for the calling agent (default: "external-agent")
- `sessionId` (optional) — continue an existing session
- `metadata` (optional) — custom metadata to attach to the session

**Response (skill matched):**

```json
{
  "success": true,
  "response": "Tokyo: ⛅️ Partly cloudy, 18°C...",
  "skill": "weather",
  "sessionId": "abc-123",
  "confidence": 0.92
}
```

**Response (no skill match):**

```json
{
  "success": true,
  "response": "2+2 equals 4",
  "skill": null,
  "sessionId": "abc-123",
  "confidence": null
}
```

### POST /agent/feedback

Submit feedback on a skill's performance.

```json
{
  "skillName": "weather",
  "positive": true,
  "comment": "Accurate and fast"
}
```

### GET /agent/health

Health check endpoint.

```json
{
  "status": "ok",
  "skills": 4
}
```

### POST /agent/sync

Sync skills from a cloud instance.

```json
{
  "cloudUrl": "https://cloud:3002",
  "force": false
}
```

### GET /agent/skills/export

Export all skills for sync (used by cloud instances).

## Programmatic usage

```ts
import { createAgentRouter } from '@agentoctopus/gateway';
import express from 'express';

const app = express();
const agentRouter = await createAgentRouter('/path/to/AgentOctopus');
app.use('/agent', agentRouter);
app.listen(3002);
```

See also: [REST API](rest-api.md) | [OpenClaw Integration](../integrations/openclaw.md) | [Deployment](../deployment/docker.md)
```

- [ ] **Step 3: Write cli-reference.md**

Create `docs/api-reference/cli-reference.md`:

```markdown
# CLI Reference

All commands are run via the `octopus` CLI after installing `agentoctopus` globally.

## Setup

### `octopus onboard`

Interactive setup wizard. Configures LLM provider, API keys, and copies built-in skills.

### `octopus connect <target>`

Import configuration from a platform (e.g., `openclaw`). Shares LLM config so you don't re-enter API keys.

### `octopus config set <key> <value>`

Write a credential to `~/.agentoctopus/octopus.json` and export it into the current session.

### `octopus config list`

List all stored credentials (values masked).

## Query

### `octopus ask <query>`

Route a natural-language query to the best-matching skill. Returns the skill result or a direct LLM answer.

```bash
octopus ask "what's the weather in Tokyo"
octopus ask "translate hello to French"
```

### `octopus list`

Show all installed skills with their names, adapters, and ratings.

## Skill management

### `octopus add <slug>`

Install a skill from ClaWHub by its slug.

### `octopus remove <name>`

Remove an installed skill by name.

### `octopus search <query>`

Search the skill marketplace.

### `octopus publish [dir]`

Publish a skill to the marketplace. Defaults to the current directory.

### `octopus skill create`

AI-assisted skill creation. Walks you through a Q&A, then uses your LLM to generate a `SKILL.md` manifest. For API-based skills it also writes a `scripts/invoke.js` stub.

### `octopus skill create --template`

Write a blank `SKILL.md` and `scripts/invoke.js` immediately — no prompts, no AI.

### `octopus skill list`

List skills (same as `octopus list`).

### `octopus skill add <slug>`

Add a skill (same as `octopus add`).

### `octopus skill remove <name>`

Remove a skill (same as `octopus remove`).

### `octopus skill search <query>`

Search skills (same as `octopus search`).

### `octopus skill publish [dir]`

Publish a skill (same as `octopus publish`).

## Sync

### `octopus sync`

Check for skill updates and install from the community catalog (5,000+ skills).

**Options:**
- `--check` — check for updates without installing
- `--category <cat>` — filter by category
- `--cloud-url <url>` — also sync from a cloud AgentOctopus instance
- `--force` — overwrite existing skills
- `--setup-gist` — set up GitHub Gist for rating sync
- `--ratings` — bidirectional rating sync
- `--ratings --pull` — pull ratings from cloud
- `--ratings --push` — push ratings to cloud

## Update

### `octopus update`

Check for and install package updates.

**Options:**
- `--check` — check only, don't install

## Server

### `octopus start`

Start the agent gateway on `http://localhost:3002` (or `AGENT_GATEWAY_PORT`).

See also: [REST API](rest-api.md) | [Configuration](../getting-started/configuration.md)
```

- [ ] **Step 4: Commit**

```bash
git add docs/api-reference/
git commit -m "docs(api-reference): write REST API, Agent Protocol, CLI Reference"
```

---

### Task 7: Write Deployment section

**Files:**
- Create: `docs/deployment/docker.md`
- Create: `docs/deployment/cloud-local.md`
- Create: `docs/deployment/security.md`

- [ ] **Step 1: Write docker.md**

Create `docs/deployment/docker.md`:

```markdown
# Docker

## Cloud deployment

Gateway + web UI:

```bash
docker compose --profile cloud up --build
# → Gateway on http://localhost:3002, Web UI on http://localhost:3000
```

## Local deployment

Gateway only, syncs skills from cloud:

```bash
CLOUD_URL=https://your-cloud-instance:3002 docker compose --profile local up --build
# → Gateway on http://localhost:3002
```

## Custom Dockerfile

```dockerfile
FROM node:18-alpine
RUN npm install -g @agentoctopus/gateway
EXPOSE 3002
CMD ["agentoctopus-gateway"]
```

```bash
docker build -t agentoctopus-gateway .
docker run -p 3002:3002 --env-file .env agentoctopus-gateway
```

## Other process managers

### PM2

```bash
npm install -g @agentoctopus/gateway pm2
pm2 start agentoctopus-gateway --name agentoctopus
pm2 save
pm2 startup
```

### systemd

```ini
[Unit]
Description=AgentOctopus Gateway
After=network.target

[Service]
Type=simple
User=agentoctopus
WorkingDirectory=/opt/agentoctopus
EnvironmentFile=/opt/agentoctopus/.env
ExecStart=/usr/bin/agentoctopus-gateway
Restart=on-failure

[Install]
WantedBy=multi-user.target
```

See also: [Cloud & Local Modes](cloud-local.md) | [Security](security.md) | [Configuration](../getting-started/configuration.md)
```

- [ ] **Step 2: Write cloud-local.md**

Create `docs/deployment/cloud-local.md`:

```markdown
# Cloud & Local Modes

AgentOctopus supports two deployment modes: **cloud** (centralized server for all users) and **local** (self-hosted, free, with skill sync from cloud).

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
|---|---|---|
| `DEPLOY_MODE` | `local` | `cloud` or `local` |
| `CLOUD_URL` | — | Cloud instance URL for skill sync |
| `SYNC_ON_STARTUP` | `true` | Auto-sync on gateway boot |
| `AGENT_GATEWAY_PORT` | `3002` | Gateway listen port |

See also: [Docker](docker.md) | [Security](security.md) | [Configuration](../getting-started/configuration.md)
```

- [ ] **Step 3: Write security.md**

Create `docs/deployment/security.md`:

```markdown
# Security

The agent gateway (`/agent/*` endpoints) includes built-in security for production deployment.

## API key authentication

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

## Rate limiting

Tier-based sliding-window rate limiting with standard headers:

| Tier | Requests/min | Requests/day | Price |
|---|---|---|---|
| Free | 10 | 100 | $0/mo |
| Pro | 60 | 5,000 | $19/mo |
| Enterprise | 300 | 50,000 | $99/mo |

Response headers: `X-RateLimit-Limit`, `X-RateLimit-Remaining`, `X-RateLimit-Reset`.

## Audit logging

All requests are logged to `logs/audit.jsonl` with:

- Timestamp, HTTP method, path, IP address
- Masked API key, user ID, tier
- Status code, response time, query content

## Environment variables

| Variable | Default | Description |
|---|---|---|
| `AUTH_ENABLED` | `true` | Enable/disable API key authentication |
| `RATE_LIMIT_ENABLED` | `true` | Enable/disable rate limiting |
| `CORS_ALLOWED_ORIGINS` | `*` | Comma-separated allowed origins |
| `API_KEYS_PATH` | `./api-keys.json` | Path to API keys store |
| `AUDIT_LOG_DIR` | `./logs` | Directory for audit log files |

## Security considerations

- The gateway supports built-in authentication — deploy behind a reverse proxy for additional protection
- Skills execute in isolated processes/containers
- No user data is persisted beyond session memory (30 min TTL)
- Rate limiting is configurable per tier

See also: [Docker](docker.md) | [Cloud & Local Modes](cloud-local.md) | [Configuration](../getting-started/configuration.md)
```

- [ ] **Step 4: Commit**

```bash
git add docs/deployment/
git commit -m "docs(deployment): write Docker, Cloud & Local Modes, Security"
```

---

### Task 8: Write Contributing section

**Files:**
- Create: `docs/contributing/adding-skills.md`
- Create: `docs/contributing/core-engine.md`
- Create: `docs/contributing/conventions.md`

- [ ] **Step 1: Write adding-skills.md**

Create `docs/contributing/adding-skills.md`:

```markdown
# Adding Skills

Adding a new skill is the primary contribution path. It requires no changes to the core engine and is the best starting point for new contributors.

## Prerequisites

- **Node.js 22+** and **pnpm** installed globally (`npm install -g pnpm`)
- A `.env` file at the repo root with LLM credentials: `cp .env.example .env`

## Skill anatomy

Every skill lives in `registry/skills/<name>/` and consists of:

- **`SKILL.md`** — gray-matter YAML frontmatter followed by plain-English instructions for the LLM. The frontmatter is validated by the Zod schema in `packages/registry/src/manifest-schema.ts`.
- **`scripts/invoke.js`** (optional) — required when `adapter: subprocess` is set. Receives `OCTOPUS_INPUT` as a JSON env variable and writes the result to stdout.

Required frontmatter fields:

```yaml
---
name: <skill-name>
description: <one-sentence description used for semantic routing>
adapter: http | mcp | subprocess
tags:
  - <tag1>
  - <tag2>
---
```

## Checklist

1. **Fork** the repository on GitHub.

2. Create a branch from `master`:
   ```bash
   git checkout master && git pull
   git checkout -b skill/<name>
   ```

3. Create `registry/skills/<name>/SKILL.md` with valid frontmatter (all four required fields: `name`, `description`, `adapter`, `tags`).

4. If using the subprocess adapter, add `scripts/invoke.js` and smoke-test it:
   ```bash
   OCTOPUS_INPUT='{"query":"<example query>"}' node registry/skills/<name>/scripts/invoke.js
   ```
   Confirm the output is correct and that the script exits non-zero with a clear message when a required API key is missing.

5. If the skill needs keyword pre-filtering, update `isSkillEligible()` in `packages/core/src/router.ts`.

6. Add a row to `TEST_INSTRUCTIONS.md` describing at least one manual test case.

7. Run the full build and test suite:
   ```bash
   pnpm build && pnpm test
   ```

8. Commit using the [conventional format](conventions.md).

9. Open a pull request against `master`. Include: skill name, API URLs, auth requirements, example queries, smoke-test output.

## What maintainers check

- Frontmatter passes Zod schema validation
- `scripts/invoke.js` runs and produces sensible output
- The script exits gracefully with a clear error when a required credential is absent
- A row is present in `TEST_INSTRUCTIONS.md`
- All CI jobs are green

## AI-assisted creation

```bash
octopus skill create          # interactive Q&A + LLM generation
octopus skill create --template  # blank template, no AI
```

See also: [Core Engine](core-engine.md) | [Conventions](conventions.md) | [Skills](../core-concepts/skills.md)
```

- [ ] **Step 2: Write core-engine.md**

Create `docs/contributing/core-engine.md`:

```markdown
# Core Engine

Changes to routing logic, adapters, the gateway, the CLI, or the web application are **trust-gated**. Maintainer review takes longer than for skill PRs.

## Before you start

Open a GitHub issue describing the problem and proposed solution. Wait for a maintainer to acknowledge before starting work. This prevents duplicated effort and ensures the change fits the project direction.

## Branch naming

```bash
git checkout master && git pull
git checkout -b feat/<topic>   # for new features
git checkout -b fix/<topic>    # for bug fixes
```

Never commit directly to master.

## Requirements

- All existing tests must continue to pass
- New behavior must be covered by new tests
- Update `README.md` and `TEST_INSTRUCTIONS.md` wherever the change affects documented behavior

## Review

A maintainer must sign off before the PR is merged. Plan for a longer review cycle than skill PRs.

## CI on pull requests

| Job | Command | Notes |
|---|---|---|
| Lint | `pnpm -r lint` | Runs first; build and test are skipped if this fails |
| Build | `pnpm -r --workspace-concurrency=1 build` | Builds all packages in topological order |
| Test | `pnpm -r test` | Uses build artifacts from the previous job |

For skill PRs, a maintainer will also run the smoke-test command locally after CI passes.

See also: [Adding Skills](adding-skills.md) | [Conventions](conventions.md)
```

- [ ] **Step 3: Write conventions.md**

Create `docs/contributing/conventions.md`:

```markdown
# Conventions

## Commit message format

```
<type>(<scope>): <short summary>

<optional body — explain why, not what>
```

**Types:** `feat`, `fix`, `docs`, `refactor`, `test`, `chore`

**Scopes:** `core`, `registry`, `adapters`, `gateway`, `web`, `cli`, or the skill name (e.g., `weather`)

**Examples:**

```
feat(registry): add my-skill with subprocess adapter

fix(core): handle empty embedding response in router

docs(contributing): add smoke-test instructions
```

## Do not commit

- `dist/` — generated build output
- `.env` — credentials
- `registry/ratings.json` — runtime state, changes on every invocation

## PR description

Every PR should explain **what** changed and **why**. For skill PRs, also include the smoke-test output.

## Code of conduct

See [CODE_OF_CONDUCT.md](../../CODE_OF_CONDUCT.md).

## Getting help

- **GitHub issues** — bug reports, feature requests, questions
- **[Architecture](../introduction/how-it-works.md)** — package structure, request flow
- **[API Reference](../api-reference/rest-api.md)** — REST endpoints and agent protocol

See also: [Adding Skills](adding-skills.md) | [Core Engine](core-engine.md)
```

- [ ] **Step 4: Commit**

```bash
git add docs/contributing/
git commit -m "docs(contributing): write Adding Skills, Core Engine, Conventions"
```

---

### Task 9: Update root README and remove old docs

**Files:**
- Modify: `README.md`
- Remove: `docs/ARCHITECTURE.md`, `docs/API.md`, `docs/DEPLOYMENT.md`, `docs/INTEGRATIONS.md`, `OPENCLAW_INTEGRATION.md`, `CONTRIBUTING.md`

- [ ] **Step 1: Trim root README to concise landing page**

Replace `README.md` content with:

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

## Quick start

```bash
npm install -g agentoctopus
octopus onboard
octopus ask "what's the weather in Tokyo"
```

## Documentation

Full documentation is available at the [GitBook docs site](docs/SUMMARY.md).

- [What is AgentOctopus?](docs/introduction/what-is-agentoctopus.md)
- [Quick Start](docs/getting-started/quick-start.md)
- [Configuration](docs/getting-started/configuration.md)
- [Routing](docs/core-concepts/routing.md)
- [Skills](docs/core-concepts/skills.md)
- [API Reference](docs/api-reference/rest-api.md)
- [Deployment](docs/deployment/docker.md)
- [Contributing](docs/contributing/adding-skills.md)

## License

Apache 2.0
```

- [ ] **Step 2: Remove old docs (content fully migrated)**

```bash
git rm docs/ARCHITECTURE.md docs/API.md docs/DEPLOYMENT.md docs/INTEGRATIONS.md OPENCLAW_INTEGRATION.md CONTRIBUTING.md
```

- [ ] **Step 3: Commit**

```bash
git add README.md
git commit -m "docs: trim README to landing page, remove migrated docs"
```

---

### Task 10: Add CI workflow for docs validation

**Files:**
- Create: `.github/workflows/docs-lint.yml`

- [ ] **Step 1: Write docs-lint.yml**

Create `.github/workflows/docs-lint.yml`:

```yaml
name: Docs Lint

on:
  pull_request:
    paths:
      - 'docs/**'

jobs:
  lint:
    runs-on: ubuntu-latest
    steps:
      - uses: actions/checkout@v4

      - name: Setup Node
        uses: actions/setup-node@v4
        with:
          node-version: '22'

      - name: Install tools
        run: npm install -g markdownlint-cli markdown-link-check

      - name: Lint markdown
        run: markdownlint docs/ --ignore docs/superpowers/

      - name: Check links
        run: |
          find docs -name '*.md' -not -path 'docs/superpowers/*' | while read f; do
            markdown-link-check "$f" --config .markdownlinkcheck.json 2>&1 || true
          done

      - name: Verify SUMMARY.md entries
        run: |
          while IFS= read -r line; do
            file=$(echo "$line" | grep -oP '\]\(\K[^)]+' | head -1)
            if [ -n "$file" ] && [ ! -f "docs/$file" ]; then
              echo "ERROR: SUMMARY.md references docs/$file but file does not exist"
              exit 1
            fi
          done < docs/SUMMARY.md
```

- [ ] **Step 2: Create markdownlinkcheck config**

Create `.markdownlinkcheck.json`:

```json
{
  "ignorePatterns": [
    { "pattern": "^http://localhost" },
    { "pattern": "^https://your-" },
    { "pattern": "^https://cloud:" }
  ],
  "timeout": "10s",
  "retryOn429": true,
  "retryCount": 2
}
```

- [ ] **Step 3: Commit**

```bash
git add .github/workflows/docs-lint.yml .markdownlinkcheck.json
git commit -m "docs(ci): add markdown lint and link check workflow"
```

---

### Task 11: Update CLAUDE.md to reference new doc structure

**Files:**
- Modify: `CLAUDE.md`

- [ ] **Step 1: Update doc references in CLAUDE.md**

In the "Keep documentation in sync" table, update the `docs/` directory references to point to the new structure. Change the row for `docs/` directory to mention the GitBook structure:

Find the existing row:
```
| Any user-visible change | `docs/` directory — check `ARCHITECTURE.md`, `INTEGRATIONS.md`, `DEPLOYMENT.md`, `API.md` and update any affected sections |
```

Replace with:
```
| Any user-visible change | `docs/` directory — check relevant section under `docs/{introduction,getting-started,core-concepts,integrations,api-reference,deployment,contributing}/` and update any affected pages |
```

- [ ] **Step 2: Commit**

```bash
git add CLAUDE.md
git commit -m "docs(claude): update doc references for GitBook structure"
```

---

### Task 12: Final verification

- [ ] **Step 1: Verify all SUMMARY.md entries have corresponding files**

```bash
while IFS= read -r line; do
  file=$(echo "$line" | grep -oP '\]\(\K[^)]+' | head -1)
  if [ -n "$file" ] && [ ! -f "docs/$file" ]; then
    echo "MISSING: docs/$file"
  fi
done < docs/SUMMARY.md
```

Expected: no output (all files exist)

- [ ] **Step 2: Verify no empty stub files remain**

```bash
find docs -name '*.md' -not -path 'docs/superpowers/*' -empty
```

Expected: no output (all files have content)

- [ ] **Step 3: Run markdownlint on new docs**

```bash
npx markdownlint-cli docs/ --ignore docs/superpowers/
```

Expected: passes with no errors (may need minor formatting fixes)

- [ ] **Step 4: Run build and tests to verify nothing broke**

```bash
pnpm build && pnpm test
```

Expected: all tests pass

- [ ] **Step 5: Commit any fixes**

```bash
git add -A
git commit -m "docs: fix lint issues from final verification"
```
