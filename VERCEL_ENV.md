# Vercel Environment Variables

This file documents the environment variables needed for Vercel deployment of AgentOctopus frontend.

## Required Environment Variables

Set these in Vercel dashboard → Project Settings → Environment Variables:

### LLM Configuration
- `LLM_PROVIDER` - LLM provider (e.g., "anthropic", "openai")
- `LLM_MODEL` - Model name (e.g., "claude-sonnet-4-6")
- `LLM_API_KEY` - API key from your LLM provider
- `LLM_BASE_URL` (optional) - Custom API endpoint if using a proxy

### Embedding Configuration
- `EMBED_PROVIDER` - Embedding provider (e.g., "anthropic", "openai")
- `EMBED_MODEL` - Embedding model name (e.g., "text-embedding-3-small")
- `EMBED_API_KEY` (optional) - Separate API key for embeddings (defaults to LLM_API_KEY)
- `EMBED_BASE_URL` (optional) - Custom embedding endpoint

### Re-ranking Configuration
- `RERANK_MODEL` - Model used for re-ranking skill candidates

### Gateway Configuration
- `GATEWAY_PORT` (optional) - Port number (default: 3000)
- `GATEWAY_CORS_ORIGINS` (optional) - Allowed CORS origins

## Notes

1. **Skills Registry**: The Vercel deployment uses a minimal skills registry
   - Only core skills (weather, translation, ip-lookup) are bundled
   - Full 4343-skill registry (309MB) is not deployable to Vercel due to size limits

2. **Config Resolution**: Config is resolved from environment variables, not from ~/.agentoctopus/octopus.json
   - The `loadConfig()` function in packages/core/src/config-resolver.ts reads from env vars
   - All `${ENV_VAR}` references are resolved at runtime

3. **Monorepo Build**: The build command builds all workspace dependencies first:
   - packages/skills → packages/registry → packages/adapters → packages/core
   - Then builds apps/web with Next.js

## Optional Features

### Authentication (if enabled)
- `AUTH_SECRET` - JWT signing secret
- `AUTH_ENABLED` - Set to "true" to enable authentication

### Rating Sync (if using cloud sync)
- `GATEWAY_SYNC_ON_STARTUP` - Set to "true" to sync ratings on startup
- `GATEWAY_CLOUD_URL` - URL of cloud instance for rating sync

### Evolution (if enabled)
- `EVOLUTION_ENABLED` - Set to "true" to enable skill self-improvement