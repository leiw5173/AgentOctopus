# Deployment

AgentOctopus supports two deployment modes: **cloud** (centralized server for all users) and **local** (self-hosted, free, with skill sync from cloud).

## Docker (recommended)

```bash
# Cloud deployment — gateway + web UI
docker compose --profile cloud up --build
# → Gateway on http://localhost:3002, Web UI on http://localhost:3000

# Local deployment — gateway only, syncs skills from cloud
CLOUD_URL=https://your-cloud-instance:3002 docker compose --profile local up --build
# → Gateway on http://localhost:3002
```

## Cloud mode

Runs the full gateway + web UI. All skills are served and available for local instances to sync from.

```bash
DEPLOY_MODE=cloud AGENT_GATEWAY_PORT=3002 agentoctopus-gateway
```

## Local mode

Runs the gateway only. Optionally syncs skills from a cloud instance on startup.

```bash
# With auto-sync from cloud
DEPLOY_MODE=local CLOUD_URL=https://cloud:3002 agentoctopus-gateway

# Manual sync via CLI
octopus sync --cloud-url https://cloud:3002

# Manual sync via API
curl -X POST http://localhost:3002/agent/sync \
  -H 'Content-Type: application/json' \
  -d '{"cloudUrl": "https://cloud:3002"}'
```

## Skill sync

Local instances can pull skills from a cloud instance:

- **On startup**: set `CLOUD_URL` env var (enabled by default, disable with `SYNC_ON_STARTUP=false`)
- **On demand**: `POST /agent/sync` or `octopus sync --cloud-url <url>`
- **Force update**: use `--force` flag or `{"force": true}` to overwrite existing skills

The cloud instance exposes `GET /agent/skills/export` which returns full skill data (SKILL.md + scripts) for sync.

## Environment variables

| Variable | Default | Description |
|----------|---------|-------------|
| `DEPLOY_MODE` | `local` | `cloud` or `local` |
| `CLOUD_URL` | — | Cloud instance URL for skill sync |
| `SYNC_ON_STARTUP` | `true` | Auto-sync on gateway boot |
| `AGENT_GATEWAY_PORT` | `3002` | Gateway listen port |

## Cloud Gateway Security

The agent gateway (`/agent/*` endpoints) includes built-in security for production deployment.

### API Key Authentication

All authenticated endpoints require an API key:

```bash
# Register for a free API key
curl -X POST https://your-gateway/agent/register \
  -H 'Content-Type: application/json' \
  -d '{"email": "you@example.com"}'
# → { "apiKey": "ak_...", "tier": "free", "limits": { ... } }

# Use the key in requests
curl -X POST https://your-gateway/agent/ask \
  -H 'Content-Type: application/json' \
  -H 'Authorization: Bearer ak_...' \
  -d '{"query": "translate hello to French"}'
```

Keys can also be passed via `X-API-Key` header or `?apiKey=` query parameter.

### Rate Limiting

Tier-based sliding-window rate limiting with standard headers:

| Tier | Requests/min | Requests/day | Price |
|------|-------------|-------------|-------|
| Free | 10 | 100 | $0/mo |
| Pro | 60 | 5,000 | $19/mo |
| Enterprise | 300 | 50,000 | $99/mo |

Response headers: `X-RateLimit-Limit`, `X-RateLimit-Remaining`, `X-RateLimit-Reset`.

### Audit Logging

All requests are logged to `logs/audit.jsonl` with:
- Timestamp, HTTP method, path, IP address
- Masked API key, user ID, tier
- Status code, response time, query content

### Security environment variables

| Variable | Default | Description |
|---|---|---|
| `AUTH_ENABLED` | `true` | Enable/disable API key authentication |
| `RATE_LIMIT_ENABLED` | `true` | Enable/disable rate limiting |
| `CORS_ALLOWED_ORIGINS` | `*` | Comma-separated allowed origins |
| `API_KEYS_PATH` | `./api-keys.json` | Path to API keys store |
| `AUDIT_LOG_DIR` | `./logs` | Directory for audit log files |
