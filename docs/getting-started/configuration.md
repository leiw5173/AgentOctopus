# Configuration

## Setup wizard

The easiest way to configure AgentOctopus:

```bash
octopus onboard
```

The wizard copies built-in skills to `~/.agentoctopus/skills/` and writes credentials to `~/.agentoctopus/octopus.json`.

## Environment variables

Copy `.env.example` and fill in your values:

```bash
cp .env.example .env
```

### LLM backend

| Variable | Default | Description |
|---|---|---|
| `LLM_PROVIDER` | `openai` | `openai`, `gemini`, or `ollama` |
| `LLM_MODEL` | `gpt-4o` | Chat model for re-ranking and direct answers |
| `OPENAI_API_KEY` | — | OpenAI API key |
| `OPENAI_BASE_URL` | — | OpenAI-compatible base URL (for proxies) |
| `GEMINI_API_KEY` | — | Google Gemini API key |
| `OLLAMA_BASE_URL` | `http://localhost:11434` | Ollama server URL |
| `OLLAMA_MODEL` | `llama3.2` | Ollama model name |

### Embeddings and reranking

Optional — omit for LLM-only routing (all eligible skills go directly to LLM re-rank).

| Variable | Default | Description |
|---|---|---|
| `EMBED_PROVIDER` | — | `openai`, `gemini`, or `ollama` |
| `EMBED_MODEL` | `text-embedding-3-small` | Embedding model |
| `EMBED_API_KEY` | — | API key for embedding provider |
| `EMBED_BASE_URL` | — | Base URL for embedding provider |
| `RERANK_MODEL` | `gpt-4o-mini` | Chat model for LLM re-ranking |

### Execution mode

| Variable | Default | Description |
|---|---|---|
| `DEPLOY_MODE` | `local` | `local` or `cloud` |
| `CLOUD_URL` | — | Cloud instance URL for skill sync |
| `SYNC_ON_STARTUP` | `true` | Auto-sync skills from cloud on gateway boot |
| `AGENT_GATEWAY_PORT` | `3002` | Gateway listen port |
| `OCTOPUS_ROOT` | `process.cwd()` | Project root directory |

### Registry paths

| Variable | Default | Description |
|---|---|---|
| `REGISTRY_PATH` | `./registry/skills` | Path to skills directory |
| `RATINGS_PATH` | `./registry/ratings.json` | Path to ratings file |

### IM bot tokens

| Variable | Description |
|---|---|
| `SLACK_BOT_TOKEN` | Slack bot token (`xoxb-...`) |
| `SLACK_SIGNING_SECRET` | Slack signing secret |
| `SLACK_APP_TOKEN` | Slack app token for socket mode (`xapp-...`) |
| `SLACK_PORT` | Slack gateway port (default: 3001) |
| `DISCORD_TOKEN` | Discord bot token |
| `TELEGRAM_BOT_TOKEN` | Telegram bot token |

### Security

| Variable | Default | Description |
|---|---|---|
| `AUTH_ENABLED` | `true` | Enable API key authentication |
| `RATE_LIMIT_ENABLED` | `true` | Enable rate limiting |
| `CORS_ALLOWED_ORIGINS` | `*` | Comma-separated allowed origins |
| `API_KEYS_PATH` | `./api-keys.json` | Path to API keys store |
| `AUDIT_LOG_DIR` | `./logs` | Directory for audit log files |

### Other

| Variable | Description |
|---|---|
| `GITHUB_TOKEN` | GitHub token for rating sync via Gist |
| `NODE_ENV` | `production` suppresses audit log detail |

## Managing credentials

```bash
# Set a credential
octopus config set COMMONS_API_KEY abc123

# List all credentials (values masked)
octopus config list

# Re-run full setup
octopus onboard
```

## User home directory

```
~/.agentoctopus/
  skills/          ← active skill registry (user-owned)
  ratings.json     ← persisted ratings
  octopus.json     ← machine-level config: skills dir path + API key credentials
```

## octopus.json options

`~/.agentoctopus/octopus.json` stores machine-level settings beyond credentials:

| Field | Default | Description |
|---|---|---|
| `skillsDir` | `~/.agentoctopus/skills` | Path to active skill registry |
| `ratingsPath` | `~/.agentoctopus/ratings.json` | Path to ratings file |
| `maxRetries` | `3` | Max skill candidates to try before falling back to direct LLM answer |
| `credentials` | `{}` | API key credentials set via `octopus config set` |
| `gistId` | — | GitHub Gist ID for rating sync |

Example — increase retry attempts:

```json
{ "maxRetries": 5 }
```

When a skill fails (network error, missing API key, 429 rate limit), `octopus ask` automatically tries the next best-matching candidate up to `maxRetries` times.

See also: [Quick Start](quick-start.md) | [Deployment](../deployment/docker.md)
