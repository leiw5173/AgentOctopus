# agentoctopus

> Intelligent routing layer that connects user needs to Skills and MCPs — install once, use everything.

This is the all-in-one package for AgentOctopus. It re-exports everything from the individual packages so you only need a single install.

## Install

```bash
# All-in-one (library + CLI)
npm install -g agentoctopus
octopus ask "translate hello to French"

# Or as a project dependency
npm install agentoctopus
```

## CLI Usage

```bash
octopus ask "translate hello to French"     # route to best skill
octopus ask "what's the weather in Tokyo?"  # weather skill
octopus ask "look up 8.8.8.8"              # ip-lookup skill
octopus list                                # show all skills
```

## Library Usage

### Route a query to a skill

```ts
import { SkillRegistry, Router, Executor, createEmbedClient, createChatClient } from 'agentoctopus';

const registry = new SkillRegistry('./registry/skills');
await registry.load();

const embedClient = createEmbedClient({
  provider: 'openai',
  model: 'text-embedding-3-small',
  apiKey: process.env.OPENAI_API_KEY,
});

const chatClient = createChatClient({
  provider: 'openai',
  model: 'gpt-4o-mini',
  apiKey: process.env.OPENAI_API_KEY,
});

const router = new Router(registry, embedClient, chatClient);
await router.buildIndex();

const [best] = await router.route('translate hello to French');
if (best) {
  const executor = new Executor();
  const result = await executor.execute(best.skill, { query: 'translate hello to French' });
  console.log(result.formattedOutput); // 'Bonjour'
}
```

### Start a Slack bot

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
```

### Start a Discord bot

```ts
import { startDiscordGateway } from 'agentoctopus';

await startDiscordGateway({ token: process.env.DISCORD_TOKEN });
```

### Start a Telegram bot

```ts
import { startTelegramGateway } from 'agentoctopus';

await startTelegramGateway({ token: process.env.TELEGRAM_BOT_TOKEN });
```

### Mount the agent-to-agent protocol

```ts
import express from 'express';
import { createAgentRouter } from 'agentoctopus';

const app = express();
app.use(express.json());
app.use('/agent', await createAgentRouter());
app.listen(3002);
```

## Individual Packages

If you only need a subset:

| Package | What it provides |
|---|---|
| [`@agentoctopus/cli`](https://www.npmjs.com/package/@agentoctopus/cli) | CLI (`octopus ask`, `octopus list`) |
| [`@agentoctopus/core`](https://www.npmjs.com/package/@agentoctopus/core) | Router, Executor, LLM client |
| [`@agentoctopus/gateway`](https://www.npmjs.com/package/@agentoctopus/gateway) | Slack/Discord/Telegram bots, agent HTTP API |
| [`@agentoctopus/registry`](https://www.npmjs.com/package/@agentoctopus/registry) | Skill manifest loader, rating store |
| [`@agentoctopus/adapters`](https://www.npmjs.com/package/@agentoctopus/adapters) | HTTP, MCP, subprocess adapters |

## Configuration

```env
LLM_PROVIDER=openai          # openai | gemini | ollama
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
