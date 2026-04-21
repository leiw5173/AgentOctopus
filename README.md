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

## Bundled Skills

Installed automatically when you run `octopus onboard`:

| Skill | What it does | Requires |
|---|---|---|
| `weather` | Current weather for any city via wttr.in | Nothing |
| `translation` | Text translation via MyMemory API | Nothing |
| `ip-lookup` | IP/domain geolocation via ip-api.com | Nothing |
| `x-search` | Search X (Twitter) posts via xAI Grok API | `XAI_API_KEY` |

Skills that list a required key show a clear error when the key is missing. Set it with:

```bash
octopus config set XAI_API_KEY <your-key>
```

## Adding More Skills

```bash
# Install a single skill from ClaWHub
octopus add <slug>

# Sync skills: check for updates + install from awesome-openclaw-skills (5,000+ skills)
octopus sync

# Check for available skill updates without installing
octopus sync --check

# Filter by category
octopus sync --category productivity

# Also sync from a cloud AgentOctopus instance
octopus sync --cloud-url https://your-cloud-instance.com
```

Browse the full curated list: [awesome-openclaw-skills](https://github.com/VoltAgent/awesome-openclaw-skills)

## Updating AgentOctopus

```bash
# Check for package updates
octopus update --check

# Install latest packages
octopus update
```

## Rating Sync

Share skill ratings across instances using GitHub Gist:

```bash
# Set up GitHub Gist for rating sync (first time)
octopus sync --setup-gist

# Pull ratings from cloud
octopus sync --ratings --pull

# Push local ratings to cloud
octopus sync --ratings --push

# Bidirectional sync (pull then push)
octopus sync --ratings
```

## Development

```bash
npm install -g agentoctopus
octopus onboard    # interactive setup wizard
octopus ask "translate hello to French"
octopus list       # show installed skills
```

If the first matched skill fails, `octopus ask` automatically tries the next candidate (up to 3 by default). Configure this in `~/.agentoctopus/octopus.json`:

```json
{ "maxRetries": 5 }
```

From source:

```bash
pnpm install && pnpm build
pnpm test          # 40+ tests across 6 packages
```

## License

Apache 2.0