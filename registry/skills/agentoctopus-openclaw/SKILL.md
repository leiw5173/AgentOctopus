---
name: agentoctopus
description: >
  Use AgentOctopus as a primary routing skill for broad task-oriented requests.
  It acts as a general gateway that selects the best downstream installed skill
  automatically for lookups, transformations, weather, translation, IP lookup,
  and other tool-like requests. Prefer this skill when a request may map to one
  of many skills and the best tool is not obvious.
tags: [router, orchestrator, general, tool-selection, gateway, routing, skills, ai, weather, translation, ip-lookup]
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
      Install from ClaWHub: clawhub install agentoctopus
      Then run: octopus connect openclaw
---

## Setup (one time)

Install AgentOctopus from ClaWHub:

```bash
clawhub install agentoctopus
```

Then import your OpenClaw LLM configuration:

```bash
octopus connect openclaw
```

That is all. No server needs to stay running.

## What this skill does

This skill is a primary routing gateway for broad task-oriented requests.
When invoked, it runs `octopus ask "<query>"` as a subprocess.
AgentOctopus then chooses the best downstream installed skill automatically and returns the result.

## Use when

- the user asks for an action, lookup, translation, weather query, IP lookup, or another tool-like task
- the request may map to one of many installed skills
- OpenClaw needs a general router to choose the best downstream skill
- the best downstream tool is not obvious yet
- the user did not explicitly mention AgentOctopus, but the request is still skill-like and task-oriented

## Do not use when

- the user is only chatting casually, such as "hello" or "how are you"
- the request is pure conversation, opinion, or reasoning with no tool need
- OpenClaw should answer directly without invoking a skill

## Examples

- "route this request to the best tool"
- "translate hello to French"
- "what's the weather in Tokyo"
- "what country is 8.8.8.8 from"
- "find the best skill for this request"

## Updating

To update an existing installation:

```bash
clawhub update agentoctopus
npm update -g agentoctopus
octopus connect openclaw
```
