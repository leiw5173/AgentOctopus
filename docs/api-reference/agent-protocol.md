# Agent Protocol

AgentOctopus provides an OpenClaw-compatible HTTP API for agent-to-agent communication. External agents can route queries to specialized skills, maintain sessions, and receive direct LLM answers when no skill matches.

## Quick start

```bash
# Install and run
npx @agentoctopus/gateway

# Or install globally
npm install -g @agentoctopus/gateway
agentoctopus-gateway
```

## Endpoints

### POST /agent/ask

Route a query to AgentOctopus.

**Request:**

```json
{
  "query": "what is the weather in Tokyo",
  "agentId": "my-openclaw-agent",
  "sessionId": "optional-session-id",
  "metadata": {}
}
```

**Parameters:**

- `query` (required) — the user's question or request
- `agentId` (optional) — identifier for the calling agent (default: "external-agent")
- `sessionId` (optional) — continue an existing session
- `metadata` (optional) — custom metadata to attach to the session

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

**Response (no skill match):**

```json
{
  "success": true,
  "response": "2+2 equals 4",
  "skill": null,
  "sessionId": "abc-123",
  "confidence": null
}
```

### POST /agent/feedback

Submit feedback on a skill's performance.

```json
{
  "skillName": "weather",
  "positive": true,
  "comment": "Accurate and fast"
}
```

### GET /agent/health

Health check endpoint.

```json
{
  "status": "ok",
  "skills": 4
}
```

### POST /agent/sync

Sync skills from a cloud instance.

```json
{
  "cloudUrl": "https://cloud:3002",
  "force": false
}
```

### GET /agent/skills/export

Export all skills for sync (used by cloud instances).

## Programmatic usage

```ts
import { createAgentRouter } from '@agentoctopus/gateway';
import express from 'express';

const app = express();
const agentRouter = await createAgentRouter('/path/to/AgentOctopus');
app.use('/agent', agentRouter);
app.listen(3002);
```

See also: [REST API](rest-api.md) | [OpenClaw Integration](../integrations/openclaw.md) | [Deployment](../deployment/docker.md)
