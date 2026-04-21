# Claude Code

Add AgentOctopus as an MCP tool in Claude Code to route tool calls through the skill system.

## Setup

```bash
# Install globally
npm install -g agentoctopus
```

Register as an MCP server in your Claude Code MCP config:

```json
{
  "mcpServers": {
    "agentoctopus": {
      "command": "octopus",
      "args": ["mcp"]
    }
  }
}
```

Claude Code will now route tool calls through AgentOctopus for skill-backed answers.

## How it works

When Claude Code encounters a query that matches a skill, it calls AgentOctopus via the MCP protocol. AgentOctopus routes the query to the best-matching skill and returns the result.

If no skill matches, the query falls back to Claude Code's default behavior.

See also: [OpenClaw](openclaw.md) | [Hermes](hermes.md) | [Skills](../core-concepts/skills.md)
