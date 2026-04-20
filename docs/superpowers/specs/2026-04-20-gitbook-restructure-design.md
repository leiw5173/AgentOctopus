# GitBook Documentation Restructure — Design Spec

**Date**: 2026-04-20
**Status**: Draft

## Problem

AgentOctopus documentation is scattered across root-level files and `docs/` with no clear hierarchy, missing key pages (Quick Start, Core Concepts, Configuration), and overlapping content (OPENCLAW_INTEGRATION.md vs docs/API.md vs docs/DEPLOYMENT.md). There is no navigation structure or maintenance mechanism to keep docs in sync with code.

## Audience

Both end users (operators using `octopus ask/sync/onboard`) and developers (skill builders, core contributors) equally. The site needs clear paths for each.

## Approach

GitBook-native structure with `SUMMARY.md` as navigation source. All public docs under `docs/`, internal docs (superpowers/, TEST_INSTRUCTIONS.md, implementation_plan.md) stay at repo root and are excluded from GitBook sync.

## Navigation Structure

```
# AgentOctopus

- Introduction
  - What is AgentOctopus? → introduction/what-is-agentoctopus.md
  - Key Features → introduction/key-features.md
  - How It Works → introduction/how-it-works.md
- Getting Started
  - Quick Start → getting-started/quick-start.md
  - Installation → getting-started/installation.md
  - Configuration → getting-started/configuration.md
- Core Concepts
  - How Routing Works → core-concepts/routing.md
  - Skills → core-concepts/skills.md
  - Rating System → core-concepts/ratings.md
  - Sessions → core-concepts/sessions.md
- Integrations
  - OpenClaw → integrations/openclaw.md
  - Claude Code → integrations/claude-code.md
  - Hermes → integrations/hermes.md
  - IM Bots → integrations/im-bots.md
  - Multi-hop Planner → integrations/multi-hop.md
- API Reference
  - REST API → api-reference/rest-api.md
  - Agent Protocol → api-reference/agent-protocol.md
  - CLI Reference → api-reference/cli-reference.md
- Deployment
  - Docker → deployment/docker.md
  - Cloud & Local Modes → deployment/cloud-local.md
  - Security → deployment/security.md
- Contributing
  - Adding Skills → contributing/adding-skills.md
  - Core Engine → contributing/core-engine.md
  - Conventions → contributing/conventions.md
```

## Content Mapping

| Existing file | Destination(s) | Notes |
|---|---|---|
| `README.md` | Root README stays as GitHub landing page (trimmed). Content is *adapted* into `introduction/what-is-agentoctopus.md` + `introduction/key-features.md` + `getting-started/quick-start.md` | Split product pitch, features, and setup steps; root README becomes a concise entry point linking to docs/ |
| `OPENCLAW_INTEGRATION.md` | `integrations/openclaw.md` | Trim to integration-only; deployment details go to deployment/ |
| `docs/ARCHITECTURE.md` | `introduction/how-it-works.md` + `core-concepts/routing.md` + `core-concepts/skills.md` | Split request flow → intro, routing details → routing, package roles → skills |
| `docs/API.md` | `api-reference/rest-api.md` + `api-reference/agent-protocol.md` | Split REST and agent protocol into separate pages |
| `docs/DEPLOYMENT.md` | `deployment/docker.md` + `deployment/cloud-local.md` + `deployment/security.md` | Split by deployment method |
| `docs/INTEGRATIONS.md` | `integrations/im-bots.md` + `integrations/multi-hop.md` | Split IM bots and planner into separate pages |
| `CONTRIBUTING.md` | `contributing/adding-skills.md` + `contributing/core-engine.md` + `contributing/conventions.md` | Split by contribution path |
| `TEST_INSTRUCTIONS.md` | Stays at root (internal) | Excluded from GitBook |
| `implementation_plan.md` | Stays at root (internal) | Excluded from GitBook |
| `docs/superpowers/` | Stays at root (internal) | Excluded from GitBook |

## New Pages to Write

- `introduction/what-is-agentoctopus.md` — product description, the problem it solves
- `introduction/key-features.md` — intent routing, multi-adapter skills, rating system, multi-platform integrations
- `getting-started/quick-start.md` — 5-minute setup guide
- `getting-started/installation.md` — detailed install (npm, Docker, from source)
- `getting-started/configuration.md` — full .env reference + onboard wizard
- `core-concepts/ratings.md` — rating dimensions, weights, feedback collection
- `core-concepts/sessions.md` — 30-min session model
- `integrations/claude-code.md` — Claude Code skill setup
- `integrations/hermes.md` — Hermes agent integration
- `api-reference/cli-reference.md` — all `octopus` commands

## Maintenance Mechanism

1. **Source of truth**: All public docs in `docs/` in the repo
2. **GitBook sync**: GitBook connects to GitHub repo, builds from `docs/SUMMARY.md`, auto-deploys on master push
3. **CI validation** (GitHub Actions on PR):
   - `markdownlint` — consistent formatting
   - `markdown-link-check` — catch broken cross-links
   - Verify `SUMMARY.md` entries match actual files
4. **CLAUDE.md rule** continues requiring doc updates alongside code changes
5. **`.gitbookignore`** excludes internal files:
   ```
   superpowers/
   ../TEST_INSTRUCTIONS.md
   ../implementation_plan.md
   ../CLAUDE.md
   ```

## Cross-linking & Terminology

- Relative paths within `docs/` (e.g., `[Routing](../core-concepts/routing.md)`)
- Root README links to `docs/` for detailed docs
- Each page starts with 1-sentence intro linking to related pages
- Terminology: lowercase "skill"/"router"/"gateway" in prose, capitalized only for filenames/classes
- Heading hierarchy: `#` = page title, `##` = sections, `###` = subsections

## Out of Scope

- FAQ section (add when real questions accumulate)
- GitBook account setup and hosting configuration
- Visual redesign beyond content structure
- Translations/i18n

## Content Verification — Outdated Info Found

Before migrating existing doc content, fix these discrepancies between code and docs:

### 1. Skills list is outdated

**Docs say** 3 bundled skills (weather, translation, ip-lookup).
**Actual registry** has 10 skills: weather, translation, ip-lookup, x-search, agent-commons, agent-team-orchestration, agentdo, agentgate, agentoctopus-openclaw, airadar.

README.md and OPENCLAW_INTEGRATION.md only list weather/translation/ip-lookup. The x-search skill (requires XAI_API_KEY) is partially documented in README but missing from OPENCLAW_INTEGRATION. The other 6 skills (agent-commons, agent-team-orchestration, agentdo, agentgate, agentoctopus-openclaw, airadar) are not documented anywhere.

**Action**: Update skills list in all affected pages. Distinguish "bundled" (weather, translation, ip-lookup, x-search) from "community/optional" (the rest).

### 2. Rating dimension weights differ from docs

**Docs say** (ARCHITECTURE.md):
- long-running: completion=0.20, quality=0.20, reliability=0.30, latency=0.20, tokenCost=0.10
- agent-collab: completion=0.20, quality=0.30, reliability=0.20, latency=0.15, tokenCost=0.15

**Actual code** (rating-dimensions.ts):
- long-running: completion=0.25, quality=0.20, reliability=0.30, latency=0.10, tokenCost=0.15
- agent-collab: completion=0.20, quality=0.30, reliability=0.25, latency=0.10, tokenCost=0.15

**Action**: Use the code values when writing new docs.

### 3. Routing flow has new features not documented

**Code has** but docs don't mention:
- Non-English query auto-translation before routing (router.ts:261-274)
- Intent extraction (LLM distills query to core intent before embedding) (router.ts:284-295)
- Catch-all skill detection and penalty (CATCHALL_PATTERN) (router.ts:26)
- Keyword-boosted skill recovery (skills missed by cosine but matched by name) (router.ts:327-338)
- Negative feedback penalty in scoring (router.ts:316-317)

**Action**: Document these in core-concepts/routing.md.

### 4. CLI commands partially documented

**Actual CLI commands** (from index.ts): update, onboard, start, list, ask, add, search, remove, publish, sync, skill (create/list/add/remove/search/publish), connect, config (set/list)

**Docs miss**: `remove`, `connect`, `skill` subcommands (create/list/add/remove/search/publish), `search`

**Action**: Write complete CLI reference in api-reference/cli-reference.md.

### 5. Environment variables partially documented

**Code uses** but docs don't list: `OCTOPUS_ROOT`, `GITHUB_TOKEN` (for rating sync), `SLACK_PORT`, `NODE_ENV`

**Action**: Include all env vars in getting-started/configuration.md, sourced from code.