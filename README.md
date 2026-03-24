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

- 🧠 **Semantic routing** — understands natural language intent
- ⭐ **Rating system** — skills are ranked by user feedback; better ones win
- 🔌 **Multi-channel** — CLI, REST API, IM bots (Slack/Discord/Telegram), agent-to-agent
- ☁️ **Hybrid execution** — skills run in cloud or locally
- 🤖 **Flexible LLM** — OpenAI, Gemini, or local Ollama
- 🔒 **Privacy-first** — encrypted credential vault, local-first option

## Quick Start (CLI)

```bash
# Install dependencies
pnpm install

# Build all packages
pnpm build

# Ask a question
node apps/cli/dist/index.js ask "translate hello to French"

# List available skills
node apps/cli/dist/index.js list
```

## Configuration

Copy `.env.example` and fill in your values:

```bash
cp .env.example .env
```

```env
LLM_PROVIDER=openai          # openai | gemini | ollama
LLM_MODEL=gpt-4o
OPENAI_API_KEY=sk-...
OLLAMA_BASE_URL=http://localhost:11434
```

## Architecture

```
AgentOctopus/
├── apps/
│   └── cli/           # CLI entry point (`octopus ask "..."`)
├── packages/
│   ├── core/          # Router + Executor + Aggregator
│   ├── registry/      # Skill manifest loader + rating store
│   └── adapters/      # HTTP, MCP, subprocess adapters
└── registry/
    └── skills/        # Built-in SKILL.md manifests
```

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

## License

Apache 2.0
