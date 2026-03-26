# @agentoctopus/core

Semantic router, executor, and LLM client for AgentOctopus.

## Install

```bash
npm install @agentoctopus/core @agentoctopus/registry @agentoctopus/adapters
```

## Usage

### Router

Embeds a query, scores it against all loaded skills, and uses an LLM re-ranker to pick the best match. Returns `[]` when no skill fits (caller should fall back to direct LLM answer).

```ts
import { SkillRegistry } from '@agentoctopus/registry';
import { Router, createEmbedClient, createChatClient } from '@agentoctopus/core';

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
  console.log(best.skill.manifest.name); // 'translation'
  console.log(best.score);              // 0.95
}
```

### Executor

Picks the right adapter for a skill and runs it:

```ts
import { Executor } from '@agentoctopus/core';

const executor = new Executor();
const result = await executor.execute(best.skill, { query: 'translate hello to French' });
console.log(result.formattedOutput); // 'Bonjour'
```

### LLM client

Supports OpenAI-compatible endpoints, Google Gemini, and Ollama:

```ts
import { createChatClient, createEmbedClient } from '@agentoctopus/core';

// OpenAI (or any compatible endpoint)
const chat = createChatClient({
  provider: 'openai',
  model: 'gpt-4o-mini',
  apiKey: process.env.OPENAI_API_KEY,
  baseURL: process.env.OPENAI_BASE_URL, // optional
});

// Gemini
const geminiChat = createChatClient({
  provider: 'gemini',
  model: 'gemini-1.5-flash',
  apiKey: process.env.GEMINI_API_KEY,
});

// Ollama (local)
const ollamaChat = createChatClient({
  provider: 'ollama',
  model: 'llama3.2',
  baseURL: 'http://localhost:11434',
});

const answer = await chat.chat('You are a helpful assistant.', 'What is 2+2?');
```

### Environment variables

The core library reads these from `process.env` (load a `.env` file before importing if needed):

```env
LLM_PROVIDER=openai          # openai | gemini | ollama
LLM_MODEL=gpt-4o-mini
OPENAI_API_KEY=sk-...
OPENAI_BASE_URL=             # optional, for compatible endpoints

EMBED_PROVIDER=openai
EMBED_MODEL=text-embedding-3-small
EMBED_API_KEY=
EMBED_BASE_URL=

RERANK_MODEL=gpt-4o-mini
```

## License

Apache 2.0
