# Config Resolver: `octopus.json` as Config Hub

## Goal

Replace ad-hoc `process.env` reads scattered across 21+ files with a single typed config resolver that loads from `~/.agentoctopus/octopus.json`. Sensitive values use `${ENV_VAR}` references resolved from `~/.agentoctopus/.env`, making `octopus.json` portable across devices (no secrets) while actual keys stay in the device-local `.env`.

## Schema (v2)

`~/.agentoctopus/octopus.json`:

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
    "apiKeysPath": null
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

- `${VAR_NAME}` = reference to `process.env[VAR_NAME]`
- Direct values for non-sensitive config (model names, URLs, ports)
- `null` = use built-in default
- `"version": 2` enables migration detection from old flat format

## Architecture

```
~/.agentoctopus/.env                     ~/.agentoctopus/octopus.json
        |                                       |
        v                                       |
   dotenv.config()                              |
        |                                       |
        v                                       v
   process.env ─────────────>  ConfigResolver.load()
                                       |
                                       | 1. Parse octopus.json (Zod)
                                       | 2. Resolve ${VAR} → process.env[VAR]
                                       | 3. Merge defaults for null fields
                                       | 4. Return frozen ResolvedConfig
                                       |
             ┌─────────────────────────┤
             v                         v
      engine.ts (gateway)       route.ts (web)
      executor.ts              adapters/*
      agent-protocol.ts        skill-create.ts
      slack.ts                 onboard.ts
      ...                      index.ts (CLI)
```

### Loading order

1. CLI entry point calls `dotenv.config({ path: "~/.agentoctopus/.env" })` to populate `process.env`
2. `ConfigResolver.load()` reads `octopus.json`, validates with Zod, resolves `${VAR}` references, fills defaults
3. Returns a frozen, typed `ResolvedConfig` singleton
4. All consumers access config via typed getters (`config.llm.apiKey`)

### Migration from v1

If `octopus.json` lacks a `version` field (old format), the resolver maps the old flat `credentials` map plus top-level keys into the new structured format and writes back a v2 file. The old `apps/cli/src/config.ts` is removed.

## New Files

- `packages/core/src/config-resolver.ts` — ConfigResolver class, Zod schema, `${VAR}` resolution, default merging
- `packages/core/src/config-types.ts` — `OctopusConfig` (raw JSON), `ResolvedConfig` (resolved), section interfaces

## Files to Modify

| File | Change |
|---|---|
| `packages/core/src/index.ts` | Export config resolver & types |
| `packages/gateway/src/engine.ts` | `process.env` → `config.llm.*`, `config.embed.*`, etc. |
| `packages/gateway/src/agent-protocol.ts` | → `config.gateway.*`, `config.auth.*`, `config.registry.*` |
| `packages/gateway/src/auth-middleware.ts` | → `config.auth.*`, `config.deploy.*` |
| `packages/gateway/src/rate-limiter.ts` | → `config.auth.*` |
| `packages/gateway/src/audit-logger.ts` | → `config.deploy.*` |
| `packages/gateway/src/slack.ts` | → `config.slack.port` |
| `packages/gateway/src/deploy-mode.ts` | → `config.deploy.mode` |
| `packages/core/src/executor.ts` | → `config.execution.*` |
| `packages/core/src/router.ts` | → `config.llm.*` |
| `packages/adapters/src/subprocess-adapter.ts` | → `config.execution.*` |
| `packages/adapters/src/http-adapter.ts` | Replace `SKILL_<NAME>_API_KEY` env reads |
| `packages/adapters/src/mcp-adapter.ts` | Replace env passthrough |
| `packages/registry/src/registry.ts` | `OCTOPUS_NO_CACHE` → `config.registry.noCache` |
| `apps/cli/src/index.ts` | dotenv target → `~/.agentoctopus/.env`; `process.env` reads → resolver |
| `apps/cli/src/onboard.ts` | Write new `octopus.json` format + `~/.agentoctopus/.env` |
| `apps/cli/src/connect.ts` | Write new `octopus.json` format |
| `apps/cli/src/skill-create.ts` | Replace env reads → resolver |
| `apps/web/src/app/api/ask/route.ts` | Replace explicit env reads → resolver |

## Files to Delete

- `apps/web/.env` — superseded by `~/.agentoctopus/.env`
- `apps/cli/src/config.ts` — replaced by `packages/core/src/config-resolver.ts`

## Edge Cases

- **Missing `octopus.json`**: resolver returns defaults-only config; CLI prints a warning suggesting `octopus onboard`
- **Missing `.env`**: `${VAR}` refs resolve to empty string, features requiring keys (embedding, LLM) degrade gracefully
- **Unknown keys**: Zod strips them, logs a warning
- **Circular refs**: `${VAR}` containing `${OTHER}` — resolver does single-pass resolution only
- **WSL paths**: `~/.agentoctopus/` resolves via `os.homedir()` (works on Windows, WSL, macOS, Linux)
