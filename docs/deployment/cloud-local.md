# Cloud & Local Modes

AgentOctopus supports two deployment modes: **cloud** (centralized server for all users) and **local** (self-hosted, free, with skill sync from cloud).

## Cloud mode

Runs the full gateway + web UI. All skills are served and available for local instances to sync from.

Set `deploy.mode` to `"cloud"` in `~/.agentoctopus/octopus.json`:

```json
{
  "deploy": { "mode": "cloud" },
  "gateway": { "port": 3002 }
}
```

## Local mode

Runs the gateway only. Optionally syncs skills from a cloud instance on startup.

```json
{
  "deploy": { "mode": "local" },
  "gateway": { "cloudUrl": "https://cloud:3002" }
}
```

```bash
# Manual sync via CLI
octopus sync --cloud-url https://cloud:3002

# Manual sync via API
curl -X POST http://localhost:3002/agent/sync \
  -H 'Content-Type: application/json' \
  -d '{"cloudUrl": "https://cloud:3002"}'
```

## Skill sync

Local instances can pull skills from a cloud instance:

- **On startup**: set `gateway.cloudUrl` in config (enabled by default, disable with `gateway.syncOnStartup: false`)
- **On demand**: `POST /agent/sync` or `octopus sync --cloud-url <url>`
- **Force update**: use `--force` flag or `{"force": true}` to overwrite existing skills

The cloud instance exposes `GET /agent/skills/export` which returns full skill data (SKILL.md + scripts) for sync.

## Configuration

All deployment settings live in `~/.agentoctopus/octopus.json`:

| Field | Type | Default | Description |
|---|---|---|---|
| `deploy.mode` | `"local" \| "cloud"` | `"local"` | Deployment mode |
| `gateway.cloudUrl` | string \| null | `null` | Cloud instance URL for skill sync |
| `gateway.syncOnStartup` | boolean | `true` | Auto-sync on gateway boot |
| `gateway.port` | number | `3002` | Gateway listen port |

See [Configuration](../getting-started/configuration.md) for all available settings.

See also: [Docker](docker.md) | [Security](security.md) | [Configuration](../getting-started/configuration.md)
