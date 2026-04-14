---
title: README Restructure Design
date: 2026-04-13
status: approved
---

# README Restructure Design

## Goal

Reduce the README from ~600 lines to ~80 lines. Primary audience is users who want to use AgentOctopus as a skill inside an AI platform (OpenClaw, Claude Code, Hermes, etc.), not library developers.

## Approach

Option B: Platform-first README + multiple focused docs under `docs/`.

## New README Structure (~80 lines)

```
# AgentOctopus
> tagline

## What is it
2-sentence description + ASCII routing flow diagram

## Use as a Skill
### OpenClaw
### Claude Code
### Hermes

## Bundled Skills
table: weather, translation, ip-lookup, x-search

## Adding More Skills
octopus add <slug> / octopus sync-awesome with link to awesome-openclaw-skills

## For Developers
Links to docs/
```

## Docs to Create

| File | Content moved from README |
|------|--------------------------|
| `docs/DEPLOYMENT.md` | Docker, cloud/local modes, skill sync, env vars, cloud gateway security, auth, rate limiting, audit logging |
| `docs/API.md` | REST endpoints, feedback API, marketplace API, agent protocol (OpenClaw-compatible HTTP API) |
| `docs/INTEGRATIONS.md` | Slack/Discord/Telegram bots, multi-hop planner, npm package table |
| `docs/ARCHITECTURE.md` | Folder tree, package responsibilities, configuration env vars (.env reference) |

## What stays in README

- Tagline / one-liner
- ASCII routing flow diagram
- "Use as a Skill" section: OpenClaw, Claude Code, Hermes (install steps per platform)
- Bundled skills table
- `octopus add` + `octopus sync-awesome` (awesome-openclaw-skills link)
- Development quick-start (pnpm install/build/test — one block)
- "For Developers" links section

## What moves out

- IM bot code samples (Slack/Discord/Telegram) → `docs/INTEGRATIONS.md`
- Multi-hop planner API → `docs/INTEGRATIONS.md`
- npm packages table → `docs/INTEGRATIONS.md`
- REST API curl examples → `docs/API.md`
- Marketplace API → `docs/API.md`
- Docker / deployment modes → `docs/DEPLOYMENT.md`
- Cloud gateway security (auth, rate limiting, audit logging) → `docs/DEPLOYMENT.md`
- Deployment env vars → `docs/DEPLOYMENT.md`
- Architecture folder tree → `docs/ARCHITECTURE.md`
- Configuration env vars (.env block) → `docs/ARCHITECTURE.md`
- Creating skills / skill wizard → `docs/INTEGRATIONS.md`
- Bundled skills home directory → `docs/ARCHITECTURE.md`
- Duplicate OpenClaw Integration section (lines 212–236) → removed, consolidated into README "Use as a Skill"

## Notes

- The current README has no "Claude Code" or "Hermes" install sections — these will be written fresh in the new README based on general skill/MCP install patterns for each platform.
- The "OpenClaw Integration" section appears twice in the current README (lines 95–117 and 212–236); the second is more detailed. The new README consolidates both into a single "Use as a Skill → OpenClaw" subsection using the best content from both.

## Success Criteria

- README ≤ 100 lines
- A new OpenClaw/Hermes/Claude Code user can get set up reading only the README
- No content is lost — everything is in a named doc
- Each doc file is self-contained with its own intro
