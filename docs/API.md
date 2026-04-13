# REST API

Start the gateway and call the API:

```bash
octopus start
```

## Endpoints

### Route a query

```bash
curl -X POST http://localhost:3002/agent/ask \
  -H 'Content-Type: application/json' \
  -d '{"query": "translate hello to French"}'
# → { "success": true, "skill": "translation", "confidence": 0.97, "response": "Bonjour" }
```

### Submit feedback

```bash
curl -X POST http://localhost:3000/api/feedback \
  -H 'Content-Type: application/json' \
  -d '{"skillName": "translation", "positive": true}'
```

### List installed skills

```bash
curl http://localhost:3000/api/skills
# → { "skills": [{ "name": "translation", "rating": 4.5, ... }] }
```

### Search the marketplace

```bash
curl http://localhost:3000/api/marketplace?q=weather
# → { "skills": [...], "total": 1 }
```

### Publish a skill to the marketplace

```bash
curl -X POST http://localhost:3000/api/marketplace \
  -H 'Content-Type: application/json' \
  -d '{"slug": "my-skill", "name": "My Skill", "description": "...", "author": "me", "skillMd": "---\nname: my-skill\n..."}'
```

### Install a skill from the marketplace

```bash
curl -X POST http://localhost:3000/api/marketplace/install \
  -H 'Content-Type: application/json' \
  -d '{"slug": "my-skill"}'
```

## Agent Protocol (OpenClaw-compatible)

AgentOctopus provides an OpenClaw-compatible HTTP API for agent-to-agent communication. External agents can route queries to specialized skills, maintain sessions, and receive direct LLM answers when no skill matches.

### Quick Start

```bash
# Install and run
npx @agentoctopus/gateway

# Or install globally
npm install -g @agentoctopus/gateway
agentoctopus-gateway
```

### Basic Usage

```bash
# Route a query with agent identity
curl -X POST http://localhost:3002/agent/ask \
  -H 'Content-Type: application/json' \
  -d '{"query": "translate hello to French", "agentId": "openclaw"}'
```

For complete integration guide including deployment options, examples, and troubleshooting, see [DEPLOYMENT.md](./DEPLOYMENT.md).
