# Integrations

## npm Packages

| Package | Description |
|---|---|
| [`agentoctopus`](https://www.npmjs.com/package/agentoctopus) | All-in-one install — includes everything below |
| [`@agentoctopus/cli`](https://www.npmjs.com/package/@agentoctopus/cli) | CLI (`octopus ask`, `list`, `add`, `search`, `publish`) |
| [`@agentoctopus/core`](https://www.npmjs.com/package/@agentoctopus/core) | Router, Executor, LLM client |
| [`@agentoctopus/gateway`](https://www.npmjs.com/package/@agentoctopus/gateway) | Slack/Discord/Telegram bots, agent HTTP API |
| [`@agentoctopus/registry`](https://www.npmjs.com/package/@agentoctopus/registry) | Skill manifest loader, rating store |
| [`@agentoctopus/adapters`](https://www.npmjs.com/package/@agentoctopus/adapters) | HTTP, MCP, subprocess adapters |

Install individual packages if you only need a subset:

```bash
npm install @agentoctopus/gateway   # IM bots + agent protocol
npm install @agentoctopus/core      # router + executor + LLM client
npm install @agentoctopus/cli       # CLI only
```

## IM Bots

Each platform adapter bootstraps the same routing engine and maintains per-user sessions (30-minute TTL, last 50 messages).

### Slack

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

### Discord

```ts
import { startDiscordGateway } from 'agentoctopus';

await startDiscordGateway({ token: process.env.DISCORD_TOKEN });
// Responds to @mentions in guilds and all DMs
```

### Telegram

```ts
import { startTelegramGateway } from 'agentoctopus';

await startTelegramGateway({ token: process.env.TELEGRAM_BOT_TOKEN });
// /ask <request>  or plain text messages
```

## Multi-hop Planner

For complex queries that involve multiple skills, the Planner decomposes the request into sub-tasks, runs them in parallel (or sequentially if there are dependencies), and synthesizes a single answer:

```ts
import { Planner, Router, Executor, SkillRegistry, createChatClient, createEmbedClient } from 'agentoctopus';

// ... set up registry, router, executor as usual ...

const planner = new Planner(chatClient, router, executor);
const result = await planner.run(
  'translate hello to French and check the weather in Paris',
  registry.getAll(),
);

console.log(result.finalAnswer);
// → "Bonjour! The weather in Paris is 22°C and sunny."

console.log(result.plan.isMultiHop);     // true
console.log(result.stepResults.length);  // 2
result.stepResults.forEach(s => {
  console.log(`${s.skill || 'LLM'}: ${s.output} (confidence: ${s.confidence})`);
});
```

Steps without dependencies run in parallel. When a step depends on a prior step's output, it waits and receives the context automatically.

## Creating Skills

### AI-assisted wizard

```bash
octopus skill create
```

Walks you through a short Q&A, then uses your configured LLM to generate a `SKILL.md` manifest. You can review, regenerate with notes, or fall back to a template. For API-based skills it also writes a `scripts/invoke.js` stub.

### Template scaffold

```bash
octopus skill create --template
```

Writes a blank `SKILL.md` and `scripts/invoke.js` immediately — no prompts, no AI. Fill them in manually.

### Manual SKILL.md

Create a new folder under `registry/skills/<skill-name>/` with a `SKILL.md`:

```markdown
---
name: my-skill
description: What this skill does and when to use it.
tags: [tag1, tag2]
version: 1.0.0
endpoint: https://api.example.com/invoke
adapter: http
---

## Instructions
...
```

### Publishing to the marketplace

```bash
cd my-skill/    # folder containing SKILL.md
octopus publish --author "your-name"
# → Published to the marketplace at http://localhost:3000/marketplace
```

Users browse `/marketplace`, click Install, restart the server — the skill is then available for routing queries.
