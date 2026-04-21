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

## Use as a Skill

### OpenClaw

Install AgentOctopus as a skill from [ClaWHub](https://clawhub.ai):

```bash
clawhub install agentoctopus
```

Import your OpenClaw LLM config (no re-entry of API keys):

```bash
octopus connect openclaw
```

OpenClaw will route queries to AgentOctopus via `octopus ask`. No server required.

**Updating:**

```bash
clawhub update agentoctopus
npm update -g agentoctopus
octopus connect openclaw   # re-run to refresh config
```

### Claude Code

Add AgentOctopus as an MCP tool in your Claude Code settings:

```bash
# Install globally
npm install -g agentoctopus

# Register as MCP server (in your Claude Code MCP config)
{
  "mcpServers": {
    "agentoctopus": {
      "command": "octopus",
      "args": ["mcp"]
    }
  }
}
```

Claude Code will now route tool calls through AgentOctopus for skill-backed answers.

### Hermes

Install via npm and point Hermes at the gateway:

```bash
npm install -g agentoctopus
octopus onboard       # configure your LLM provider
octopus start         # starts gateway on http://localhost:3002
```

Add AgentOctopus as a tool in your Hermes agent config:

```json
{
  "tools": [{
    "name": "agentoctopus",
    "endpoint": "http://localhost:3002/agent/ask",
    "description": "Routes queries to the best available skill"
  }]
}
```

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

## For Developers

- [docs/API.md](docs/API.md) — REST endpoints, marketplace API, agent protocol
- [docs/DEPLOYMENT.md](docs/DEPLOYMENT.md) — Docker, cloud/local modes, security, rate limiting
- [docs/INTEGRATIONS.md](docs/INTEGRATIONS.md) — Slack/Discord/Telegram bots, multi-hop planner, npm packages
- [docs/ARCHITECTURE.md](docs/ARCHITECTURE.md) — Package structure, configuration reference, `.env` vars

## License

Apache 2.0
