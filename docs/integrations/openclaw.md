# OpenClaw

AgentOctopus provides an OpenClaw-compatible HTTP API for agent-to-agent communication.

## Install as a skill

```bash
clawhub install agentoctopus
```

Import your OpenClaw LLM config (no re-entry of API keys):

```bash
octopus connect openclaw
```

OpenClaw will route queries to AgentOctopus via `octopus ask`. No server required.

## Updating

```bash
clawhub update agentoctopus
npm update -g agentoctopus
octopus connect openclaw   # re-run to refresh config
```

## API endpoints

### Route a query

```bash
curl -X POST http://localhost:3002/agent/ask \
  -H 'Content-Type: application/json' \
  -d '{"query": "translate hello to French", "agentId": "openclaw"}'
```

**Response (skill matched):**

```json
{
  "success": true,
  "response": "Bonjour",
  "skill": "translation",
  "sessionId": "abc-123",
  "confidence": 0.92
}
```

**Response (no skill match):**

```json
{
  "success": true,
  "response": "2+2 equals 4",
  "skill": null,
  "sessionId": "abc-123",
  "confidence": null
}
```

### Submit feedback

```bash
curl -X POST http://localhost:3002/agent/feedback \
  -H 'Content-Type: application/json' \
  -d '{"skillName": "weather", "positive": true, "comment": "Accurate and fast"}'
```

### Health check

```bash
curl http://localhost:3002/agent/health
# → {"status": "ok", "skills": 4}
```

## Session continuation

```bash
# First query
curl -X POST http://localhost:3002/agent/ask \
  -H 'Content-Type: application/json' \
  -d '{"query": "what is the weather in Paris", "agentId": "openclaw-main"}'
# Returns: {"sessionId": "abc-123", ...}

# Follow-up in same session
curl -X POST http://localhost:3002/agent/ask \
  -H 'Content-Type: application/json' \
  -d '{"query": "how about London", "sessionId": "abc-123"}'
```

## Python client

```python
import requests

class AgentOctopusClient:
    def __init__(self, base_url="http://localhost:3002"):
        self.base_url = base_url
        self.session_id = None

    def ask(self, query, agent_id="openclaw"):
        payload = {"query": query, "agentId": agent_id}
        if self.session_id:
            payload["sessionId"] = self.session_id
        response = requests.post(f"{self.base_url}/agent/ask", json=payload)
        data = response.json()
        if data.get("success"):
            self.session_id = data.get("sessionId")
        return data

    def feedback(self, skill_name, positive, comment=None):
        payload = {"skillName": skill_name, "positive": positive}
        if comment:
            payload["comment"] = comment
        return requests.post(f"{self.base_url}/agent/feedback", json=payload).json()
```

See also: [Agent Protocol](../api-reference/agent-protocol.md) | [Deployment](../deployment/docker.md) | [Sessions](../core-concepts/sessions.md)
