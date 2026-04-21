# Skills

Skills are the building blocks of AgentOctopus. Each skill is a self-contained capability that can be automatically selected by the router.

## Skill anatomy

Every skill lives in `registry/skills/<name>/` and consists of:

- **`SKILL.md`** — gray-matter YAML frontmatter + markdown instructions for the LLM
- **`scripts/invoke.js`** (optional) — required when `adapter: subprocess`

### SKILL.md frontmatter

```yaml
---
name: my-skill
description: What this skill does and when to use it.
tags: [tag1, tag2]
version: 1.0.0
adapter: http | mcp | subprocess
endpoint: https://api.example.com/invoke  # for http adapter
---
```

Required fields: `name`, `description`, `adapter`, `tags`.

### Environment variable requirements

Skills that need API keys declare them in frontmatter:

```yaml
metadata:
  openclaw:
    env: ["COMMONS_API_KEY"]
    homepage: "https://example.com"
```

The executor checks these before invocation. Missing vars produce a clear error:

```
✘ Skill "agent-commons" requires environment variables that are not set:
  COMMONS_API_KEY  — get yours at https://agentcommons.net
Run: octopus config set COMMONS_API_KEY <your-key>
```

## Adapters

| Adapter | How it works | When to use |
|---|---|---|
| `http` | POST to an API endpoint | External REST APIs |
| `mcp` | stdio-based Model Context Protocol | MCP-compatible tools |
| `subprocess` | Run a local Node.js script | Local scripts, free APIs |

## Bundled skills

Installed automatically by `octopus onboard`:

| Skill | What it does | Adapter | Requires |
|---|---|---|---|
| `weather` | Current weather via wttr.in | subprocess | Nothing |
| `translation` | Text translation via MyMemory API | subprocess | Nothing |
| `ip-lookup` | IP/domain geolocation via ip-api.com | subprocess | Nothing |
| `x-search` | Search X (Twitter) via xAI Grok API | subprocess | `XAI_API_KEY` |

## Community skills

Available via `octopus sync` (5,000+ from ClaWHub):

| Skill | What it does | Requires |
|---|---|---|
| `agent-commons` | Shared reasoning layer for AI agents | `COMMONS_API_KEY` |
| `agent-team-orchestration` | Multi-agent team orchestration | Nothing |
| `agentdo` | Task queue for AI agents | `AGENTDO_API_KEY` |
| `agentgate` | API gateway for personal data | `AGENT_GATE_TOKEN` + `AGENT_GATE_URL` |
| `ai-tools-github-radar` | AI tooling and GitHub traction | Nothing |

## Adding skills

```bash
# Install from ClaWHub
octopus add <slug>

# Sync from community catalog
octopus sync

# Create a new skill
octopus skill create
```

See [Adding Skills](../contributing/adding-skills.md) for the full contribution guide.

See also: [Routing](routing.md) | [Rating System](ratings.md) | [Quick Start](../getting-started/quick-start.md)
