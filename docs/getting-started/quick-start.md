# Quick Start

Get AgentOctopus running in 5 minutes.

## 1. Install

```bash
npm install -g agentoctopus
```

## 2. Configure

```bash
octopus onboard
```

The interactive wizard will:

- Ask for your LLM provider and API key
- Set up embedding for skill routing
- Copy built-in skills to `~/.agentoctopus/skills/`

## 3. Use

```bash
octopus ask "what's the weather in Tokyo"
octopus ask "translate hello to French"
octopus list
```

## Next steps

- [Add more skills](../core-concepts/skills.md) from the 5,000+ community catalog
- [Configure integrations](../integrations/openclaw.md) with OpenClaw, Claude Code, or Hermes
- [Deploy the gateway](../deployment/docker.md) for API access
- [Understand routing](../core-concepts/routing.md) to tune skill selection
