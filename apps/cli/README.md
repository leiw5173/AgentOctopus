# @agentoctopus/cli

Command-line interface for AgentOctopus — route natural language queries to skills from your terminal.

## Install

```bash
npm install -g @agentoctopus/cli
```

## Usage

### Ask a question

```bash
octopus ask "translate hello to French"
# → Bonjour

octopus ask "what's the weather in Tokyo?"
# → Tokyo: ⛅ Partly cloudy, 18°C, Humidity: 72%, Wind: 14km/h

octopus ask "look up 8.8.8.8"
# → IP: 8.8.8.8 | Google LLC | US, United States
```

After each answer, you'll be prompted for feedback (`y`/`n`) which is used to rank skills over time.

### List available skills

```bash
octopus list
# NAME         DESCRIPTION                          RATING  USES
# translation  Translate text between languages     4.8     12
# weather      Get current weather for any city     4.5     7
# ip-lookup    Look up IP address or domain info    4.0     3
```

## Configuration

Create a `.env` file in your working directory (or set environment variables):

```env
LLM_PROVIDER=openai          # openai | gemini | ollama
LLM_MODEL=gpt-4o-mini
OPENAI_API_KEY=sk-...
OPENAI_BASE_URL=             # optional, for compatible endpoints

EMBED_PROVIDER=openai
EMBED_MODEL=text-embedding-3-small
EMBED_API_KEY=
EMBED_BASE_URL=

REGISTRY_PATH=./registry/skills     # path to your skill manifests
RATINGS_PATH=./registry/ratings.json
```

## Adding custom skills

Point `REGISTRY_PATH` at a folder of `SKILL.md` files:

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

Detailed instructions for the LLM on how/when to invoke this skill.
```

See [`@agentoctopus/registry`](https://www.npmjs.com/package/@agentoctopus/registry) for the full skill manifest format.

## License

Apache 2.0
