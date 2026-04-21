# Architecture

## Package Structure

```
AgentOctopus/
├── apps/
│   ├── cli/           # CLI entry point (`octopus ask/list/add/update/sync/config/onboard`)
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
├── scripts/
│   └── build-skills-index.js   # Daily index builder (standalone Node ESM, outside pnpm workspace)
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
               on failure: tries next candidate (up to maxRetries, default 3)
               all failed → falls back to direct LLM answer
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
  octopus.json     ← machine-level config: skills dir path + API key credentials + maxRetries
```

To set or update a credential without re-running the full wizard:

```bash
# Write a key to octopus.json and export it into the current session
octopus config set COMMONS_API_KEY abc123

# List all stored credentials (values masked)
octopus config list
```

To change the skills directory or run full setup again:

```bash
octopus onboard
```

## Skills Index Bundle

`octopus sync` downloads a pre-built, daily-refreshed index instead of
fetching 5,000+ skills one-by-one from ClaWHub:

```
GitHub Action (daily, 02:00 UTC)
  → fetch all slugs from awesome-openclaw-skills
  → download ZIPs from ClaWHub (server-side, generous delays)
  → build skills-index.json  (slug, name, SKILL.md, _meta.json, scripts/*, files/*)
  → gzip → upload to GitHub Release tag: skills-index-latest

octopus sync
  → Phase 1: check installed skills for updates from index
  → Phase 2: GET skills-index.json.gz  (1 request, ~3–5 MB)
  → gunzip + parse in memory
  → apply --category / --limit filters locally (no extra network calls)
  → write SKILL.md + _meta.json + scripts/* + all other files per skill
  → patch missing files for existing skills without --force
  → Phase 3 (optional): sync from cloud instance via --cloud-url
  → done in ~10 seconds for 5,000+ skills
```

If the GitHub Release asset is unavailable, `sync` prints a warning and
automatically falls back to the original per-skill ClaWHub fetch path.

## SKILL.md — `metadata.openclaw` field

Skills that require API keys at runtime declare them in SKILL.md frontmatter:

```yaml
metadata:
  openclaw:
    env: ["COMMONS_API_KEY"]        # env var name(s) required at runtime
    homepage: "https://example.com" # shown in the error hint URL (optional)
```

Before invoking a skill the `Executor` checks every listed variable. If any are
missing it aborts with a clear, actionable message:

```
✘ Skill "agent-commons" requires environment variables that are not set:

  COMMONS_API_KEY  — get yours at https://agentcommons.net

Run: octopus config set COMMONS_API_KEY <your-key>
```

Skills that need no keys can omit `metadata.openclaw` entirely.

## Rating System

Each skill is evaluated on 5 dimensions, stored in `registry/ratings.json`:

| Dimension | Range | Type | Source |
|---|---|---|---|
| `completion` | 0-1 | Objective | Auto-collected success/failure count |
| `quality` | 0-5 | Subjective | EMA of user thumbs-up/down feedback |
| `reliability` | 0-1 | Objective | 1 - (error rate from auto-collected metrics) |
| `latency` | 0-1 | Objective | Normalized response speed |
| `tokenCost` | 0-1 | Objective | Cost efficiency from token usage |

The router computes a composite `routingScore` (0-1) as a weighted average, with weights that adapt by task type:

| Task type | completion | quality | reliability | latency | tokenCost |
|---|---|---|---|---|---|
| one-shot | 0.30 | 0.25 | 0.20 | 0.15 | 0.10 |
| long-running | 0.20 | 0.20 | 0.30 | 0.20 | 0.10 |
| agent-collab | 0.20 | 0.30 | 0.20 | 0.15 | 0.15 |

Feedback sources: CLI thumbs up/down, web thumbs up/down, agent platforms (NLP keyword sentiment detection).

Ratings can be synced across instances via GitHub Gist (`sync --ratings`, `--setup-gist`, `--pull`, `--push`).

## Test Coverage

| Package | Tests |
|---|---|
| `packages/registry` | 15 |
| `packages/adapters` | 3 |
| `packages/core` | 14 |
| `apps/cli` | 3 |
| `apps/web` | 6 |
| `packages/gateway` | 11 |
