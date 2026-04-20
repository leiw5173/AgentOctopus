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