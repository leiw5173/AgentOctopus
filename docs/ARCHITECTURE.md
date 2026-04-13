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
