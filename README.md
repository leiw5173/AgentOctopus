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
- **Multi-hop planner** — decomposes complex queries into parallel sub-tasks with dependency tracking
- **Confidence scoring** — normalized 0-1 confidence on every routing result
- **Rating system** — skills are ranked by user feedback; better ones win
- **Skill marketplace** — built-in marketplace to publish, browse, and install community skills
- **ClaWHub integration** — install skills from [clawhub.ai](https://clawhub.ai) with `octopus add`
- **Web UI** — chat interface with skills sidebar, dark/light mode, and marketplace browser
- **Multi-channel** — CLI, REST API, IM bots (Slack/Discord/Telegram), agent-to-agent
- **Hybrid execution** — skills run in cloud or locally
- **Flexible LLM** — OpenAI, Gemini, or local Ollama
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

- Web UI + Chat on `http://localhost:3000`
- Skill Marketplace on `http://localhost:3000/marketplace`
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

# List installed skills
curl http://localhost:3000/api/skills
# → { "skills": [{ "name": "translation", "rating": 4.5, ... }] }

# Search the marketplace
curl http://localhost:3000/api/marketplace?q=weather
# → { "skills": [...], "total": 1 }

# Publish a skill to the marketplace
curl -X POST http://localhost:3000/api/marketplace \
  -H 'Content-Type: application/json' \
  -d '{"slug": "my-skill", "name": "My Skill", "description": "...", "author": "me", "skillMd": "---\nname: my-skill\n..."}'

# Install a skill from the marketplace
curl -X POST http://localhost:3000/api/marketplace/install \
  -H 'Content-Type: application/json' \
  -d '{"slug": "my-skill"}'
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

## OpenClaw Integration

AgentOctopus provides an OpenClaw-compatible HTTP API for agent-to-agent communication. External agents can route queries to specialized skills, maintain sessions, and receive direct LLM answers when no skill matches.

**Quick Start:**

```bash
# Install and run
npx @agentoctopus/gateway

# Or install globally
npm install -g @agentoctopus/gateway
agentoctopus-gateway
```

**Basic Usage:**

```bash
# Route a query
curl -X POST http://localhost:3002/agent/ask \
  -H 'Content-Type: application/json' \
  -d '{"query": "translate hello to French", "agentId": "openclaw"}'
```

For complete integration guide including deployment options, API documentation, examples, and troubleshooting, see **[OPENCLAW_INTEGRATION.md](./OPENCLAW_INTEGRATION.md)**.

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
│   ├── cli/           # CLI entry point (`octopus ask/list/add/publish`)
│   └── web/           # Next.js web UI, REST API, and marketplace
│       ├── /           # Chat interface with skills sidebar
│       └── /marketplace  # Skill marketplace browser
├── packages/
│   ├── agentoctopus/  # Umbrella package — re-exports everything
│   ├── core/          # Router + Executor + Planner + LLM client
│   ├── registry/      # Skill manifest loader + rating store + remote catalog
│   ├── adapters/      # HTTP, MCP stdio, subprocess adapters
│   └── gateway/       # IM bots (Slack/Discord/Telegram) + agent protocol + sessions
└── registry/
    ├── skills/        # Built-in SKILL.md manifests
    └── marketplace/   # Published skills + index.json
```

### npm Packages

| Package | Description |
|---|---|
| [`agentoctopus`](https://www.npmjs.com/package/agentoctopus) | All-in-one install — includes everything below |
| [`@agentoctopus/cli`](https://www.npmjs.com/package/@agentoctopus/cli) | CLI (`octopus ask`, `list`, `add`, `search`, `publish`) |
| [`@agentoctopus/core`](https://www.npmjs.com/package/@agentoctopus/core) | Router, Executor, LLM client |
| [`@agentoctopus/gateway`](https://www.npmjs.com/package/@agentoctopus/gateway) | Slack/Discord/Telegram bots, agent HTTP API |
| [`@agentoctopus/registry`](https://www.npmjs.com/package/@agentoctopus/registry) | Skill manifest loader, rating store |
| [`@agentoctopus/adapters`](https://www.npmjs.com/package/@agentoctopus/adapters) | HTTP, MCP, subprocess adapters |

## Adding a Skill

### From the AgentOctopus Marketplace

The built-in marketplace lets you publish, browse, and install skills via the web UI or CLI:

```bash
# Browse the marketplace web UI
# Start the server, then visit http://localhost:3000/marketplace

# Publish your own skill
cd my-skill/    # folder containing SKILL.md
octopus publish --author "your-name"
# → Published to the marketplace at http://localhost:3000/marketplace

# Install from marketplace via API
curl -X POST http://localhost:3000/api/marketplace/install \
  -H 'Content-Type: application/json' \
  -d '{"slug": "my-skill"}'
```

**Skill author workflow:**

```
1. Create a folder with SKILL.md (YAML frontmatter + instructions)
2. Run `octopus publish --author "you"` to push to the marketplace
3. Users browse /marketplace, click Install, restart the server
4. The skill is now available for routing queries
```

### From ClaWHub

Browse the [ClaWHub skill registry](https://clawhub.ai) and install with one command:

```bash
# Search for skills
octopus search "self-improving"

# Install a skill from ClaWHub
octopus add self-improving-agent

# Remove a skill
octopus remove self-improving-agent
```

### Manual

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
pnpm test          # run all tests (40+ tests across 6 packages)
pnpm dev           # watch mode for all packages
```

### Test coverage

| Package | Tests |
|---|---|
| `packages/registry` | 9 |
| `packages/adapters` | 3 |
| `packages/core` | 14 |
| `apps/cli` | 3 |
| `apps/web` | 6 |
| `packages/gateway` | 11 |

## License

Apache 2.0
