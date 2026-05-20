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

## Key Features

| Feature | Description |
|---|---|
| **Smart Routing** | Embedding similarity + keyword matching + LLM re-rank with rating-aware scoring |
| **Multi-Agent** | Isolate agents with separate workspaces, models, and skill registries |
| **Multi-Channel** | CLI, REST API, Slack, Discord, Telegram, WebSocket WebChat, generic Webhooks |
| **Skill Composition** | Chain skills into execution DAGs with input/output mapping |
| **Sandbox Execution** | Run skills in Docker, SSH, or OpenShell for isolation |
| **DM Security** | Pairing mode for unknown direct-message senders |
| **Self-Evolving** | Skills auto-improve based on execution signals and user feedback |

## Quick start

```bash
npm install -g agentoctopus
octopus onboard
octopus ask "what's the weather in Tokyo"
```

## Documentation

Full documentation is available at the [GitBook docs site](https://agentoctopus.gitbook.io/readme).

- [What is AgentOctopus?](https://agentoctopus.gitbook.io/readme/what-is-agentoctopus/how-it-works)
- [Quick Start](https://agentoctopus.gitbook.io/readme/quick-start)
- [Configuration](https://agentoctopus.gitbook.io/readme/quick-start/configuration)
- [Skills](https://agentoctopus.gitbook.io/readme/routing/skills) — bundled skills, adding community skills, API key setup
- [CLI Reference](docs/api-reference/cli-reference.md) — `ask`, `sync`, `update`, retry config
- [Routing](https://agentoctopus.gitbook.io/readme/routing)
- [API Reference](docs/api-reference/rest-api.md)
- [Deployment](docs/deployment/docker.md)
- [Contributing](docs/contributing/adding-skills.md)

## Development

```bash
npm install -g agentoctopus
octopus onboard    # interactive setup wizard
octopus ask "translate hello to French"
octopus list       # show installed skills
octopus search "weather"    # search local skills by name, description, and tags
octopus search "weather" --run  # search and interactively pick a skill to run
```

[![CI](https://github.com/leiw5173/AgentOctopus/actions/workflows/ci.yml/badge.svg)](https://github.com/leiw5173/AgentOctopus/actions/workflows/ci.yml)

From source:

```bash
pnpm install && pnpm build
pnpm test          # 235+ tests across 8 packages
```

### Publishing

Releases use [changesets](https://github.com/changesets/changesets) with unified fixed versioning across all packages. See [CLAUDE.md — Versioning & Publishing](CLAUDE.md#versioning--publishing) for the full process.

## License

Apache 2.0