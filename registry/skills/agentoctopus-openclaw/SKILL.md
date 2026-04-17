---
name: agentoctopus
description: >
  Use AgentOctopus as a primary routing skill for broad task-oriented requests.
  It acts as a general gateway that selects the best downstream installed skill
  automatically for lookups, transformations, weather, translation, IP lookup,
  and other tool-like requests. Prefer this skill when a request may map to one
  of many skills and the best tool is not obvious.
tags: [router, orchestrator, general, tool-selection, gateway, routing, skills, ai, weather, translation, ip-lookup]
version: 1.1.0
adapter: subprocess
hosting: local
input_schema:
  query: string
output_schema:
  result: string
auth: none
taskType: agent-collab
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

## Adding more skills

Install individual skills from [ClaWHub](https://clawhub.ai):

```bash
octopus add <slug>
```

Or sync from the [awesome-openclaw-skills](https://github.com/VoltAgent/awesome-openclaw-skills) curated list (5,000+ skills):

```bash
octopus sync

# Check for available updates
octopus sync --check

# Filter by category
octopus sync --category productivity
```

## Updating

To update an existing installation:

```bash
octopus update
octopus sync
octopus connect openclaw
```

## Rating & Feedback

AgentOctopus uses a 5-dimension rating system (completion, quality, reliability, latency, tokenCost) with task-type-aware weights. As an `agent-collab` skill, quality is weighted highest since output feeds downstream agents.

Feedback is collected from all platforms (CLI, web, OpenClaw, Hermes). Positive/negative signals from natural language are auto-detected.

### Sync ratings across machines

```bash
# Set up GitHub Gist for cloud sync (one-time)
octopus sync --setup-gist

# Pull ratings from cloud
octopus sync --ratings --pull

# Push local ratings to cloud
octopus sync --ratings --push

# Bidirectional sync (merge local + cloud)
octopus sync --ratings
```
