# OpenClaw Integration Guide

This guide explains how to integrate AgentOctopus with OpenClaw as an agent-to-agent service.

## Overview

AgentOctopus exposes an OpenClaw-compatible HTTP API that allows external agents to:
- Route queries to specialized skills (weather, translation, IP lookup, etc.)
- Maintain conversation sessions with 30-minute expiry
- Submit feedback to improve skill routing
- Fall back to direct LLM answers when no skill matches

## Quick Start

### 1. Prerequisites

- Node.js 18+ installed
- AgentOctopus built and configured
- LLM API keys configured in `.env`

### 2. Build AgentOctopus

```bash
cd /path/to/AgentOctopus
pnpm install
pnpm build
```

### 3. Configure Environment

Create or update `.env` in the project root:

```env
# LLM Configuration (for routing and direct answers)
LLM_PROVIDER=openai
LLM_MODEL=gpt-4o-mini
OPENAI_API_KEY=sk-...
OPENAI_BASE_URL=https://api.openai.com/v1

# Embedding Configuration (for skill routing)
EMBED_PROVIDER=openai
EMBED_MODEL=text-embedding-3-small
EMBED_API_KEY=sk-...
EMBED_BASE_URL=https://api.openai.com/v1

# Re-ranking model
RERANK_MODEL=gpt-4o-mini

# Skill registry paths
REGISTRY_PATH=./registry/skills
RATINGS_PATH=./registry/ratings.json

# Optional: Custom port (default: 3002)
AGENT_GATEWAY_PORT=3002
```

### 4. Start the Agent Gateway

**Option A: Standalone server (recommended)**

```bash
# From project root
pnpm --filter @agentoctopus/gateway start:agent
```

The gateway will start on `http://localhost:3002` (or your configured port).

**Option B: Programmatic (embed in your app)**

```typescript
import { createAgentRouter } from '@agentoctopus/gateway';
import express from 'express';

const app = express();
const agentRouter = await createAgentRouter('/path/to/AgentOctopus');
app.use('/agent', agentRouter);
app.listen(3002);
```

## API Endpoints

### POST /agent/ask

Route a query to AgentOctopus. Returns skill result or direct LLM answer.

**Request:**
```json
{
  "query": "what is the weather in Tokyo",
  "agentId": "my-openclaw-agent",
  "sessionId": "optional-session-id",
  "metadata": {}
}
```

**Response (skill matched):**
```json
{
  "success": true,
  "response": "Tokyo: ⛅️ Partly cloudy, 18°C...",
  "skill": "weather",
  "sessionId": "abc-123",
  "confidence": 0.92
}
```

**Response (no skill match - direct answer):**
```json
{
  "success": true,
  "response": "2+2 equals 4",
  "skill": null,
  "sessionId": "abc-123",
  "confidence": null
}
```

**Parameters:**
- `query` (required): The user's question or request
- `agentId` (optional): Identifier for the calling agent (default: "external-agent")
- `sessionId` (optional): Continue an existing session, or create new one
- `metadata` (optional): Custom metadata to attach to the session

### POST /agent/feedback

Submit feedback on a skill's performance.

**Request:**
```json
{
  "skillName": "weather",
  "positive": true,
  "comment": "Accurate and fast"
}
```

**Response:**
```json
{
  "success": true
}
```

### GET /agent/health

Health check endpoint.

**Response:**
```json
{
  "status": "ok",
  "skills": 3
}
```

## Integration Examples

### Example 1: Simple Query from OpenClaw

```bash
curl -X POST http://localhost:3002/agent/ask \
  -H 'Content-Type: application/json' \
  -d '{
    "query": "translate hello to Spanish",
    "agentId": "openclaw-main"
  }'
```

### Example 2: Session Continuation

```bash
# First query
curl -X POST http://localhost:3002/agent/ask \
  -H 'Content-Type: application/json' \
  -d '{"query": "what is the weather in Paris", "agentId": "openclaw-main"}'
# Returns: {"sessionId": "abc-123", ...}

# Follow-up in same session
curl -X POST http://localhost:3002/agent/ask \
  -H 'Content-Type: application/json' \
  -d '{"query": "how about London", "sessionId": "abc-123"}'
```

### Example 3: Python Client

```python
import requests

class AgentOctopusClient:
    def __init__(self, base_url="http://localhost:3002"):
        self.base_url = base_url
        self.session_id = None

    def ask(self, query, agent_id="openclaw"):
        payload = {"query": query, "agentId": agent_id}
        if self.session_id:
            payload["sessionId"] = self.session_id

        response = requests.post(
            f"{self.base_url}/agent/ask",
            json=payload
        )
        data = response.json()

        if data.get("success"):
            self.session_id = data.get("sessionId")

        return data

    def feedback(self, skill_name, positive, comment=None):
        payload = {"skillName": skill_name, "positive": positive}
        if comment:
            payload["comment"] = comment

        return requests.post(
            f"{self.base_url}/agent/feedback",
            json=payload
        ).json()

# Usage
client = AgentOctopusClient()
result = client.ask("what is the weather in Tokyo")
print(result["response"])
```

## How It Works

### Skill Routing

1. **Embedding**: Query is embedded using configured embedding model
2. **Cosine similarity**: Compared against skill index
3. **Pre-filtering**: `isSkillEligible()` applies hard filters (e.g., IP lookup requires IP address)
4. **LLM re-ranking**: Top candidates sent to LLM for final selection
5. **Execution**: Chosen skill invoked via HTTP, MCP, or subprocess adapter
6. **Fallback**: If no skill matches, direct LLM answer is returned

### Session Management

- Sessions keyed by `platform + channelId + userId`
- 30-minute expiry after last activity
- Stores last 50 messages per session
- Automatic cleanup of expired sessions

## Deployment Options

### Option 1: Docker (Recommended for Production)

```dockerfile
FROM node:18-alpine
WORKDIR /app
COPY . .
RUN npm install -g pnpm && pnpm install && pnpm build
EXPOSE 3002
CMD ["pnpm", "--filter", "@agentoctopus/gateway", "start:agent"]
```

```bash
docker build -t agentoctopus-gateway .
docker run -p 3002:3002 --env-file .env agentoctopus-gateway
```

### Option 2: PM2 (Process Manager)

```bash
pm2 start packages/gateway/dist/bin/start-agent-gateway.js --name agentoctopus-gateway
pm2 save
pm2 startup
```

### Option 3: systemd Service

```ini
[Unit]
Description=AgentOctopus Gateway
After=network.target

[Service]
Type=simple
User=agentoctopus
WorkingDirectory=/opt/agentoctopus
EnvironmentFile=/opt/agentoctopus/.env
ExecStart=/usr/bin/node packages/gateway/dist/bin/start-agent-gateway.js
Restart=on-failure

[Install]
WantedBy=multi-user.target
```

## Troubleshooting

### Gateway won't start

**Problem**: `OPENAI_API_KEY environment variable is missing`

**Solution**: Ensure `.env` file exists in project root and contains valid API keys. The gateway loads env vars from the working directory.

```bash
# Verify .env is loaded
cat .env
# Start from project root
cd /path/to/AgentOctopus
pnpm --filter @agentoctopus/gateway start:agent
```

### No skills found

**Problem**: `{"status": "ok", "skills": 0}`

**Solution**: Check `REGISTRY_PATH` points to correct skills directory.

```bash
ls registry/skills/  # Should show: weather, translation, ip-lookup
```

### Skills not routing correctly

**Problem**: All queries return direct answers instead of using skills

**Solution**: Check embedding configuration and re-ranking model.

```bash
# Test embedding endpoint
curl -X POST $EMBED_BASE_URL/embeddings \
  -H "Authorization: Bearer $EMBED_API_KEY" \
  -d '{"input": "test", "model": "text-embedding-3-small"}'
```

### Port already in use

**Problem**: `Error: listen EADDRINUSE: address already in use :::3002`

**Solution**: Change port or kill existing process.

```bash
# Use different port
export AGENT_GATEWAY_PORT=3003
# Or kill existing process
lsof -ti:3002 | xargs kill
```

## Testing

Run the included test script to verify the integration:

```bash
chmod +x tests/test-openclaw-integration.sh
./tests/test-openclaw-integration.sh
```

This will test:
- Health check endpoint
- Weather skill routing
- Translation skill routing
- Direct LLM answers (no skill match)
- Feedback submission

## Available Skills

AgentOctopus currently includes three production-ready skills:

| Skill | Description | Example Query |
|-------|-------------|---------------|
| **weather** | Real-time weather via wttr.in | "what's the weather in Tokyo" |
| **translation** | Text translation via MyMemory API | "translate hello to French" |
| **ip-lookup** | IP/domain geolocation via ip-api.com | "lookup 8.8.8.8" |

All skills use free APIs with no authentication required.

## Adding Custom Skills

To add your own skills, see the [main README](./README.md#adding-skills) for instructions on creating `SKILL.md` manifests.

## Architecture Notes

- **Stateless**: Each request is independent (except session continuity)
- **Concurrent**: Multiple agents can connect simultaneously
- **Scalable**: Run multiple gateway instances behind a load balancer
- **Extensible**: Add new skills without restarting (restart required for skill index rebuild)

## Security Considerations

- The gateway has no built-in authentication - deploy behind a reverse proxy with auth if needed
- Skills execute in isolated processes/containers
- No user data is persisted beyond session memory (30 min TTL)
- Rate limiting should be implemented at the reverse proxy level

## Performance

- Typical response time: 200-500ms for skill routing
- Embedding lookup: ~50ms
- LLM re-ranking: ~100-200ms
- Skill execution: varies by skill (weather: ~300ms, translation: ~200ms)

## Support

- GitHub Issues: https://github.com/leiw5173/AgentOctopus/issues
- Documentation: See [README.md](./README.md)
- Test Instructions: See [TEST_INSTRUCTIONS.md](./TEST_INSTRUCTIONS.md)

## License

Apache 2.0
