# Configuration

## Setup wizard

The easiest way to configure AgentOctopus:

```bash
octopus onboard
```

The wizard copies built-in skills to `~/.agentoctopus/skills/`, writes structured config to `~/.agentoctopus/octopus.json`, and stores secrets in `~/.agentoctopus/.env`.

## Configuration hub: octopus.json

AgentOctopus reads all config from `~/.agentoctopus/octopus.json` (v2 format). Sensitive values use `${ENV_VAR}` references resolved from `~/.agentoctopus/.env` — this keeps secrets device-local while `octopus.json` remains portable across devices.

### Full schema

```json
{
  "version": 2,
  "llm": {
    "provider": "openai",
    "model": "gpt-4o",
    "apiKey": "${OPENAI_API_KEY}",
    "baseUrl": "https://api.openai.com/v1"
  },
  "embed": {
    "provider": "openai",
    "model": "text-embedding-3-small",
    "apiKey": "${EMBED_API_KEY}",
    "baseUrl": "https://api.openai.com/v1"
  },
  "rerank": {
    "model": "gpt-4o-mini"
  },
  "gateway": {
    "port": 3002,
    "corsOrigins": ["*"],
    "cloudUrl": null,
    "syncOnStartup": true
  },
  "registry": {
    "skillsDir": "./registry/skills",
    "ratingsPath": "./registry/ratings.json",
    "noCache": false
  },
  "execution": {
    "timeoutMs": 30000,
    "maxRetries": 3,
    "timing": false
  },
  "deploy": {
    "mode": "local",
    "root": null
  },
  "auth": {
    "enabled": true,
    "apiKeysPath": null,
    "rateLimitEnabled": true
  },
  "rating": {
    "feedbackSharing": true,
    "gistId": null
  },
  "slack": {
    "port": 3001
  }
}
```

### LLM backend

| Field | Type | Default | Description |
|---|---|---|---|
| `llm.provider` | `"openai" \| "gemini" \| "ollama"` | `"openai"` | LLM provider |
| `llm.model` | string | `"gpt-4o"` | Chat model for re-ranking and direct answers |
| `llm.apiKey` | string | `""` | API key (use `${VAR}` reference) |
| `llm.baseUrl` | string | `"https://api.openai.com/v1"` | API base URL (for proxies) |

### Embeddings and reranking

Optional — omit for LLM-only routing (all eligible skills go directly to LLM re-rank).

| Field | Type | Default | Description |
|---|---|---|---|
| `embed.provider` | `"openai" \| "gemini" \| "ollama"` | `"openai"` | Embedding provider |
| `embed.model` | string | `"text-embedding-3-small"` | Embedding model |
| `embed.apiKey` | string | `""` | API key for embedding provider |
| `embed.baseUrl` | string | `""` | Base URL for embedding provider |
| `rerank.model` | string | `"gpt-4o-mini"` | Chat model for LLM re-ranking |

### Execution mode

| Field | Type | Default | Description |
|---|---|---|---|
| `deploy.mode` | `"local" \| "cloud"` | `"local"` | Deployment mode |
| `gateway.cloudUrl` | string \| null | `null` | Cloud instance URL for skill sync |
| `gateway.syncOnStartup` | boolean | `true` | Auto-sync skills from cloud on gateway boot |
| `gateway.port` | number | `3002` | Gateway listen port |
| `deploy.root` | string \| null | `null` | Project root directory (default: `process.cwd()`) |

### Registry paths

| Field | Type | Default | Description |
|---|---|---|---|
| `registry.skillsDir` | string | `"./registry/skills"` | Path to skills directory |
| `registry.ratingsPath` | string | `"./registry/ratings.json"` | Path to ratings file |
| `registry.noCache` | boolean | `false` | Disable registry cache |

### Execution tuning

| Field | Type | Default | Description |
|---|---|---|---|
| `execution.timeoutMs` | number | `30000` | Skill execution timeout (ms) |
| `execution.maxRetries` | number | `3` | Max skill candidates to try before falling back to direct LLM |
| `execution.timing` | boolean | `false` | Enable `--debug` timing by default |

### Security

| Field | Type | Default | Description |
|---|---|---|---|
| `auth.enabled` | boolean | `true` | Enable API key authentication |
| `auth.rateLimitEnabled` | boolean | `true` | Enable rate limiting |
| `auth.apiKeysPath` | string \| null | `null` | Path to API keys store |
| `gateway.corsOrigins` | string[] | `["*"]` | Allowed CORS origins |

### Rating

| Field | Type | Default | Description |
|---|---|---|---|
| `rating.feedbackSharing` | boolean | `true` | Enable feedback sharing |
| `rating.gistId` | string \| null | `null` | GitHub Gist ID for rating sync |

### Multi-agent config

| Field | Type | Default | Description |
|---|---|---|---|
| `agents.default` | string | `"default"` | Default agent ID for unrouted requests |
| `agents.entries[].id` | string | (required) | Unique agent identifier |
| `agents.entries[].name` | string | same as `id` | Human-readable name |
| `agents.entries[].model` | object | (inherited) | Per-agent LLM config override |
| `agents.entries[].workspace` | string | auto | Agent workspace directory |
| `agents.entries[].dmPolicy` | `"pairing" \| "open"` | `"pairing"` | DM security policy |
| `agents.entries[].sandbox.enabled` | boolean | `false` | Enable sandbox for this agent |
| `agents.entries[].sandbox.backend` | `"docker" \| "ssh" \| "openshell" \| "none"` | `"none"` | Sandbox backend |

### Sandbox (global defaults)

| Field | Type | Default | Description |
|---|---|---|---|
| `sandbox.defaultBackend` | `"docker" \| "ssh" \| "openshell" \| "none"` | `"none"` | Default sandbox backend |
| `sandbox.docker.image` | string | `"node:20-alpine"` | Default Docker image |
| `sandbox.docker.memory` | string | `"512m"` | Memory limit |
| `sandbox.docker.network` | `"bridge" \| "none" \| "host"` | `"none"` | Container network mode |
| `sandbox.ssh.host` | string | — | SSH remote host |
| `sandbox.ssh.user` | string | — | SSH remote user |
| `sandbox.ssh.keyPath` | string | — | SSH private key path |

### Canvas & Companion (future)

| Field | Type | Default | Description |
|---|---|---|---|
| `canvas.enabled` | boolean | `false` | Enable Live Canvas / A2UI |
| `canvas.port` | number | `3003` | Canvas WebSocket port |
| `companion.enabled` | boolean | `false` | Enable companion app protocol |
| `companion.port` | number | `3004` | Companion WebSocket port |
| `companion.heartbeatIntervalMs` | number | `30000` | Companion heartbeat interval |

### IM bot ports

| Field | Type | Default | Description |
|---|---|---|---|
| `slack.port` | number | `3001` | Slack gateway port |

## .env file (secrets)

`~/.agentoctopus/.env` holds actual secret values. `octopus.json` references them with `${VAR}`:

```bash
# ~/.agentoctopus/.env
OPENAI_API_KEY=sk-your-key-here
EMBED_API_KEY=sk-your-embed-key
GEMINI_API_KEY=your-gemini-key
```

### IM bot tokens

| Variable | Description |
|---|---|
| `SLACK_BOT_TOKEN` | Slack bot token (`xoxb-...`) |
| `SLACK_SIGNING_SECRET` | Slack signing secret |
| `SLACK_APP_TOKEN` | Slack app token for socket mode (`xapp-...`) |
| `DISCORD_TOKEN` | Discord bot token |
| `TELEGRAM_BOT_TOKEN` | Telegram bot token |

These are read directly from `process.env` (loaded from `.env` by the config resolver) since they're only needed when the corresponding bot is running.

### Other env vars

| Variable | Description |
|---|---|
| `GITHUB_TOKEN` | GitHub token for rating sync via Gist |
| `NODE_ENV` | `production` suppresses audit log detail |
| `SKILL_EXEC_TIMEOUT_MS` | Override `execution.timeoutMs` for subprocess adapter |

## Managing credentials

```bash
# Set a credential (writes to octopus.json v2 format)
octopus config set OPENAI_API_KEY sk-abc123

# List all credentials (values masked)
octopus config list

# Re-run full setup
octopus onboard
```

## Import from other tools

```bash
# Import LLM config from OpenClaw
octopus connect openclaw
```

This reads the existing OpenClaw config and writes it into `octopus.json` v2 format.

## User home directory

```
~/.agentoctopus/
  .env             ← device-local secrets (API keys, tokens)
  octopus.json     ← portable config hub (v2 format, ${VAR} references)
  skills/          ← active skill registry (user-owned)
  ratings.json     ← persisted ratings
```

## V1 migration

Old v1 `octopus.json` (flat `credentials` map) is auto-migrated to v2 on first load. Secrets are extracted to `~/.agentoctopus/.env` and replaced with `${VAR}` references in the config file.

See also: [Quick Start](quick-start.md) | [Deployment](../deployment/docker.md)
