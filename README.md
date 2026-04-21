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
- [Skills](docs/core-concepts/skills.md) — bundled skills, adding community skills, API key setup
- [CLI Reference](docs/api-reference/cli-reference.md) — `ask`, `sync`, `update`, retry config
- [Routing](docs/core-concepts/routing.md)
- [API Reference](docs/api-reference/rest-api.md)
- [Deployment](docs/deployment/docker.md)
- [Contributing](docs/contributing/adding-skills.md)

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

## License

Apache 2.0