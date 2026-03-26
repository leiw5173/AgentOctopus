# AgentOctopus

> Intelligent routing layer that connects user needs to Skills and MCPs — no installation required.

## Overview

Users express their intent in plain language. AgentOctopus automatically selects, invokes, and returns results from the best-matching Skill or MCP — with zero setup required by the end user.

```
User: "Translate hello to French"
        │
        ▼
  AgentOctopus  ←  intent routing + rating-aware selection
        │
        ▼
  Translation Skill  (cloud or local)
        │
        ▼
  "Bonjour"
```

## Features

- **Semantic routing** — understands natural language intent
- **Rating system** — skills are ranked by user feedback; better ones win
- **Multi-channel** — CLI, REST API, IM bots (Slack/Discord/Telegram), agent-to-agent
- **Hybrid execution** — skills run in cloud or locally
- **Flexible LLM** — OpenAI, Gemini, or local Ollama
- **Privacy-first** — encrypted credential vault, local-first option
- **Stateful sessions** — conversation context persists across turns on all channels

## Install

```bash
# All-in-one (CLI + full library)
npm install -g agentoctopus
octopus ask "translate hello to French"
octopus list
```

Or install individual packages if you only need a subset:

```bash
npm install @agentoctopus/gateway   # IM bots + agent protocol
npm install @agentoctopus/core      # router + executor + LLM client
npm install @agentoctopus/cli       # CLI only
```

## Quick Start (from source)

```bash
# Install dependencies once
pnpm install

# Start the full service
pnpm exec octopus start
```

This starts:

- Web UI + REST API on `http://localhost:3000`
- Agent gateway on `http://localhost:3002`

```bash
# Or use the CLI directly
pnpm build
pnpm exec octopus ask "translate hello to French"
pnpm exec octopus list
```

## REST API

Start the service and call the API:

```bash
pnpm exec octopus start

# Route a query
curl -X POST http://localhost:3000/api/ask \
  -H 'Content-Type: application/json' \
  -d '{"query": "translate hello to French"}'
# → { "success": true, "skill": "translation", "confidence": 0.97, "response": "Bonjour" }

# Submit feedback
curl -X POST http://localhost:3000/api/feedback \
  -H 'Content-Type: application/json' \
  -d '{"skillName": "translation", "positive": true}'
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

## Agent-to-Agent Protocol

The gateway exposes an OpenClaw-compatible HTTP API for agent-to-agent calls:

```bash
# Start the standalone agent gateway (default port 3002)
pnpm --filter @agentoctopus/gateway start:agent

# Route a query from an external agent
curl -X POST http://localhost:3002/agent/ask \
  -H 'Content-Type: application/json' \
  -d '{"query": "translate hello to French", "agentId": "my-agent"}'
# → { "success": true, "response": "Bonjour", "skill": "translation",
#     "sessionId": "abc-123", "confidence": 0.95 }

# Continue the session
curl -X POST http://localhost:3002/agent/ask \
  -H 'Content-Type: application/json' \
  -d '{"query": "now translate goodbye", "sessionId": "abc-123"}'

# Submit feedback
curl -X POST http://localhost:3002/agent/feedback \
  -H 'Content-Type: application/json' \
  -d '{"skillName": "translation", "positive": true}'

# Health check
curl http://localhost:3002/agent/health
# → { "status": "ok", "skills": 3 }
```

Or mount the router inside an existing Express app:

```ts
import express from 'express';
import { createAgentRouter } from 'agentoctopus';

const app = express();
const agentRouter = await createAgentRouter();
app.use('/agent', agentRouter);
app.listen(3000);
```

## Configuration

Copy `.env.example` and fill in your values:

```bash
cp .env.example .env
```

```env
# LLM backend
LLM_PROVIDER=openai          # openai | gemini | ollama
LLM_MODEL=gpt-5.4
OPENAI_API_KEY=sk-...
OPENAI_BASE_URL=https://your-openai-compatible-base-url/v1

# Embeddings and reranking
EMBED_PROVIDER=openai        # defaults to LLM_PROVIDER
EMBED_MODEL=text-embedding-3-small
EMBED_API_KEY=
EMBED_BASE_URL=https://your-embedding-base-url/v1
RERANK_MODEL=gpt-4o-mini

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

General questions that do not match a registered skill fall back to the configured chat model directly. Skill routing uses embeddings plus an LLM reranker, so if you split providers you should ensure both the chat and embedding endpoints are reachable.

## Architecture

```
AgentOctopus/
├── apps/
│   ├── cli/           # CLI entry point (`octopus ask "..."`)
│   └── web/           # Next.js web UI & REST API (POST /api/ask, POST /api/feedback)
├── packages/
│   ├── agentoctopus/  # Umbrella package — re-exports everything
│   ├── core/          # Router + Executor + LLM client
│   ├── registry/      # Skill manifest loader + rating store + remote catalog
│   ├── adapters/      # HTTP, MCP stdio, subprocess adapters
│   └── gateway/       # IM bots (Slack/Discord/Telegram) + agent protocol + sessions
└── registry/
    └── skills/        # Built-in SKILL.md manifests
```

### npm Packages

| Package | Description |
|---|---|
| [`agentoctopus`](https://www.npmjs.com/package/agentoctopus) | All-in-one install — includes everything below |
| [`@agentoctopus/cli`](https://www.npmjs.com/package/@agentoctopus/cli) | CLI (`octopus ask`, `octopus list`) |
| [`@agentoctopus/core`](https://www.npmjs.com/package/@agentoctopus/core) | Router, Executor, LLM client |
| [`@agentoctopus/gateway`](https://www.npmjs.com/package/@agentoctopus/gateway) | Slack/Discord/Telegram bots, agent HTTP API |
| [`@agentoctopus/registry`](https://www.npmjs.com/package/@agentoctopus/registry) | Skill manifest loader, rating store |
| [`@agentoctopus/adapters`](https://www.npmjs.com/package/@agentoctopus/adapters) | HTTP, MCP, subprocess adapters |

## Adding a Skill

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

## Development

```bash
pnpm install       # install all dependencies
pnpm build         # build all packages
pnpm test          # run all tests (35 tests across 6 packages)
pnpm dev           # watch mode for all packages
```

### Test coverage

| Package | Tests |
|---|---|
| `packages/registry` | 9 |
| `packages/adapters` | 3 |
| `packages/core` | 6 |
| `apps/cli` | 1 |
| `apps/web` | 6 |
| `packages/gateway` | 10 |

## License

Apache 2.0
