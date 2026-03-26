# @agentoctopus/gateway

IM bot gateways (Slack, Discord, Telegram) and agent-to-agent HTTP protocol for AgentOctopus.

## Install

```bash
npm install @agentoctopus/gateway
```

## Usage

### Slack bot

Responds to `@mentions` and direct messages. Requires a Slack app with Socket Mode enabled.

```ts
import { startSlackGateway } from '@agentoctopus/gateway';

await startSlackGateway({
  appOptions: {
    token: process.env.SLACK_BOT_TOKEN,
    signingSecret: process.env.SLACK_SIGNING_SECRET,
    socketMode: true,
    appToken: process.env.SLACK_APP_TOKEN,
  },
  rootDir: './my-skills-root', // optional, defaults to cwd
});
```

Required env vars: `SLACK_BOT_TOKEN`, `SLACK_SIGNING_SECRET`, `SLACK_APP_TOKEN`

### Discord bot

Responds to `@mentions` in guild channels and all direct messages.

```ts
import { startDiscordGateway } from '@agentoctopus/gateway';

await startDiscordGateway({
  token: process.env.DISCORD_TOKEN,
  requireMention: true, // default: true for guilds, false for DMs
});
```

Required env var: `DISCORD_TOKEN`

### Telegram bot

Handles `/ask <request>` commands and plain text messages via long-polling.

```ts
import { startTelegramGateway } from '@agentoctopus/gateway';

await startTelegramGateway({
  token: process.env.TELEGRAM_BOT_TOKEN,
});
```

Required env var: `TELEGRAM_BOT_TOKEN`

### Agent-to-agent HTTP protocol

Mount an OpenClaw-compatible Express router in your own app:

```ts
import express from 'express';
import { createAgentRouter } from '@agentoctopus/gateway';

const app = express();
app.use(express.json());

const agentRouter = await createAgentRouter();
app.use('/agent', agentRouter);
app.listen(3002);
```

Available routes:

```bash
# Route a query
POST /agent/ask
{ "query": "translate hello to French", "agentId": "my-agent" }
# → { "success": true, "response": "Bonjour", "skill": "translation",
#     "sessionId": "abc-123", "confidence": 0.95 }

# Continue a session
POST /agent/ask
{ "query": "now translate goodbye", "sessionId": "abc-123" }

# Submit feedback
POST /agent/feedback
{ "skillName": "translation", "positive": true }

# Health check
GET /agent/health
# → { "status": "ok", "skills": 3 }
```

Or run the standalone gateway server:

```bash
npx @agentoctopus/gateway start:agent   # listens on port 3002
# set AGENT_PORT env var to change the port
```

### Session management

All gateways share a stateful session manager. Sessions are keyed by `platform + channelId + userId`, expire after 30 minutes of inactivity, and keep the last 50 messages.

```ts
import { sessionManager } from '@agentoctopus/gateway';

const session = sessionManager.getOrCreate('channel-id', 'user-id', 'slack');
sessionManager.addMessage(session, { role: 'user', content: 'hello', timestamp: Date.now() });

// Clean up expired sessions
sessionManager.prune();
```

## Configuration

All gateways read the same environment variables as `@agentoctopus/core`:

```env
LLM_PROVIDER=openai
LLM_MODEL=gpt-4o-mini
OPENAI_API_KEY=sk-...

EMBED_PROVIDER=openai
EMBED_MODEL=text-embedding-3-small
EMBED_API_KEY=
EMBED_BASE_URL=

REGISTRY_PATH=./registry/skills
RATINGS_PATH=./registry/ratings.json
```

## License

Apache 2.0
