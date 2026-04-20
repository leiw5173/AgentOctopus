# Hermes

Use AgentOctopus as a tool for Hermes agents via the gateway HTTP API.

## Setup

```bash
npm install -g agentoctopus
octopus onboard       # configure your LLM provider
octopus start         # starts gateway on http://localhost:3002
```

Add AgentOctopus as a tool in your Hermes agent config:

```json
{
  "tools": [{
    "name": "agentoctopus",
    "endpoint": "http://localhost:3002/agent/ask",
    "description": "Routes queries to the best available skill"
  }]
}
```

Hermes will send queries to the gateway, which routes them through the skill system and returns results.

See also: [OpenClaw](openclaw.md) | [Claude Code](claude-code.md) | [REST API](../api-reference/rest-api.md)
