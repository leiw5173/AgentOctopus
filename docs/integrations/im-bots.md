# IM Bots

AgentOctopus provides built-in bots for Slack, Discord, and Telegram. Each bootstraps the same routing engine and maintains per-user sessions (30-minute TTL, last 50 messages).

## Slack

```ts
import { startSlackGateway } from 'agentoctopus';

await startSlackGateway({
  appOptions: {
    token: process.env.SLACK_BOT_TOKEN,
    signingSecret: process.env.SLACK_SIGNING_SECRET,
    socketMode: true,
    appToken: process.env.SLACK_APP_TOKEN,
  },
});
// Responds to @mentions and direct messages
```

Required env vars: `SLACK_BOT_TOKEN`, `SLACK_SIGNING_SECRET`, `SLACK_APP_TOKEN`.

## Discord

```ts
import { startDiscordGateway } from 'agentoctopus';

await startDiscordGateway({ token: process.env.DISCORD_TOKEN });
// Responds to @mentions in guilds and all DMs
```

Required env var: `DISCORD_TOKEN`.

## Telegram

```ts
import { startTelegramGateway } from 'agentoctopus';

await startTelegramGateway({ token: process.env.TELEGRAM_BOT_TOKEN });
// /ask <request>  or plain text messages
```

Required env var: `TELEGRAM_BOT_TOKEN`.

## npm packages

| Package | Description |
|---|---|
| [`agentoctopus`](https://www.npmjs.com/package/agentoctopus) | All-in-one — includes everything below |
| [`@agentoctopus/gateway`](https://www.npmjs.com/package/@agentoctopus/gateway) | IM bots + agent HTTP API |
| [`@agentoctopus/core`](https://www.npmjs.com/package/@agentoctopus/core) | Router, Executor, LLM client |
| [`@agentoctopus/registry`](https://www.npmjs.com/package/@agentoctopus/registry) | Skill manifest loader, rating store |
| [`@agentoctopus/adapters`](https://www.npmjs.com/package/@agentoctopus/adapters) | HTTP, MCP, subprocess adapters |

See also: [Sessions](../core-concepts/sessions.md) | [Configuration](../getting-started/configuration.md)
