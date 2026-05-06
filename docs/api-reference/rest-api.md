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

Note: The CLI `octopus search` command now searches local skills rather than the marketplace. Marketplace search remains available via this API endpoint and `octopus sync`.

### Publish a skill

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

See also: [Agent Protocol](agent-protocol.md) | [CLI Reference](cli-reference.md) | [Security](../deployment/security.md)
