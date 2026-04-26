# Security

The agent gateway (`/agent/*` endpoints) includes built-in security for production deployment.

## API key authentication

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

## Rate limiting

Tier-based sliding-window rate limiting with standard headers:

| Tier | Requests/min | Requests/day | Price |
|---|---|---|---|
| Free | 10 | 100 | $0/mo |
| Pro | 60 | 5,000 | $19/mo |
| Enterprise | 300 | 50,000 | $99/mo |

Response headers: `X-RateLimit-Limit`, `X-RateLimit-Remaining`, `X-RateLimit-Reset`.

## Audit logging

All requests are logged to `<deploy.root>/logs/audit.jsonl` (defaults to `./logs`) with:

- Timestamp, HTTP method, path, IP address
- Masked API key, user ID, tier
- Status code, response time, query content

## Configuration

Security settings are configured in `~/.agentoctopus/octopus.json` under the `auth` and `gateway` sections:

| Field | Type | Default | Description |
|---|---|---|---|
| `auth.enabled` | boolean | `true` | Enable/disable API key authentication |
| `auth.rateLimitEnabled` | boolean | `true` | Enable/disable rate limiting |
| `auth.apiKeysPath` | string \| null | `null` | Path to API keys store |
| `gateway.corsOrigins` | string[] | `["*"]` | Allowed CORS origins |

See [Configuration](../getting-started/configuration.md) for all available settings.

## Security considerations

- The gateway supports built-in authentication — deploy behind a reverse proxy for additional protection
- Skills execute in isolated processes/containers
- No user data is persisted beyond session memory (30 min TTL)
- Rate limiting is configurable per tier

See also: [Docker](docker.md) | [Cloud & Local Modes](cloud-local.md) | [Configuration](../getting-started/configuration.md)
