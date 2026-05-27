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

## Self-evolving skills

Skills automatically improve over time based on execution signals and user feedback. The evolution system analyzes skill performance, proposes targeted fixes via LLM, and applies safe changes automatically — with shadow-copy rollback for safety. Use `octopus evolve --check` to see status.

## Session management

Per-user sessions with 30-minute TTL and 50-message history. Supports follow-up queries in context. See [Sessions](../core-concepts/sessions.md).

See also: [How It Works](how-it-works.md) | [Routing](../core-concepts/routing.md)
