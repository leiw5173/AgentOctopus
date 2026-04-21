# Cloud & Local Modes

AgentOctopus supports two deployment modes: **cloud** (centralized server for all users) and **local** (self-hosted, free, with skill sync from cloud).

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
|---|---|---|
| `DEPLOY_MODE` | `local` | `cloud` or `local` |
| `CLOUD_URL` | — | Cloud instance URL for skill sync |
| `SYNC_ON_STARTUP` | `true` | Auto-sync on gateway boot |
| `AGENT_GATEWAY_PORT` | `3002` | Gateway listen port |

See also: [Docker](docker.md) | [Security](security.md) | [Configuration](../getting-started/configuration.md)
