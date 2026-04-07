---
name: agentoctopus
description: >
  Route queries to AgentOctopus — an intelligent skill router that automatically
  selects and invokes the best-matching skill for any natural language query.
  Handles weather, translation, IP lookup, and any other installed skills.
  Use when the user wants to delegate to AgentOctopus or when no other skill fits.
tags: [routing, skills, ai, delegation, weather, translation, ip-lookup]
version: 1.0.0
adapter: subprocess
hosting: local
input_schema:
  query: string
output_schema:
  result: string
auth: none
rating: 5.0
invocations: 0
metadata:
  openclaw:
    emoji: "🐙"
    requires:
      bins: [node, npx]
    setup: |
      Install AgentOctopus CLI: npm install -g agentoctopus
      Then run: octopus connect openclaw
---

## Setup (one time)

Install the AgentOctopus CLI globally:

```bash
npm install -g agentoctopus
```

Import your OpenClaw LLM configuration (no re-entry required):

```bash
octopus connect openclaw
```

That's it. No server to start.

## How It Works

When invoked, this skill runs `octopus ask "<query>"` as a subprocess.
AgentOctopus routes the query to the best matching skill (weather, translation,
IP lookup, or any other installed skill) and returns the result.

## Invoke

Pass the user's full natural language question — the router picks the skill automatically.

Example queries:
- "What's the weather in Tokyo?"
- "Translate hello to French"
- "What country is IP 8.8.8.8 from?"
