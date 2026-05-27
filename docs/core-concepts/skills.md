# Skills

Skills are the building blocks of AgentOctopus. Each skill is a self-contained capability that can be automatically selected by the router.

## Skill anatomy

Every skill lives in `registry/skills/<name>/` and consists of:

- **`SKILL.md`** — gray-matter YAML frontmatter + markdown instructions for the LLM. The frontmatter is validated by the Zod schema in `packages/skills/src/schema.ts`.
- **`scripts/invoke.js`** (optional) — required for subprocess execution. Receives `OCTOPUS_INPUT` as a JSON env variable and writes the result to stdout.

### SKILL.md frontmatter

```yaml
---
name: my-skill
description: What this skill does and when to use it.
tags: [tag1, tag2]
version: "1.0.0"
os: [darwin, linux]
primaryEnv: MY_API_KEY
requires:
  bins: [curl]
  anyBins: [python3, python]
  env: [MY_API_KEY]
  config: [browser.enabled]
always: false
user-invocable: true
disable-model-invocation: false
---
```

Execution strategy is derived from directory contents (scripts/, MCP metadata), not declared in frontmatter.

Required fields: `name`, `description`.

### Eligibility gating

Skills declare their runtime requirements in the frontmatter. The skills package evaluates eligibility automatically — no code changes needed in the router:

- `os` — restrict to specific platforms
- `requires.bins` — ALL must exist on PATH
- `requires.anyBins` — AT LEAST ONE must exist
- `requires.env` — ALL env vars must be set
- `requires.config` — ALL config paths must be truthy
- `always: true` — bypass all gates

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
| `composed` | Execute a chain of sub-skills | Multi-step workflows |

### Composed skills (skill chaining)

Skills can declare a `compose` block to chain other skills into an execution DAG:

```yaml
---
name: research-and-summarize
adapter: composed
compose:
  steps:
    - skill: web-search
      inputMapping:
        query: "{{query}}"
      outputAs: search_results
    - skill: summarize
      inputMapping:
        text: search_results
      outputAs: summary
---
```

Each step can optionally have a `condition` (evaluated by LLM) to enable conditional branching.

## Sandbox

Skills can request isolated execution via the `sandbox` frontmatter field:

```yaml
---
name: untrusted-code-runner
adapter: subprocess
sandbox:
  backend: docker
  image: python:3.11-alpine
  memory: 256m
---
```

Sandbox backends:

| Backend | Isolation level | Use case |
|---|---|---|
| `docker` | Container (network-off, memory-limited) | Untrusted or resource-heavy skills |
| `ssh` | Remote host execution | Offload to dedicated compute |
| `openshell` | Local pass-through | Fallback / trusted environment |
| `none` | No isolation | Default |

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
