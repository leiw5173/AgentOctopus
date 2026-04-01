# CLAUDE.md

This file provides guidance to Claude Code (claude.ai/code) when working with code in this repository.

## Development Rules

These rules apply to every code change, no exceptions.

### 1. Build & test before committing

After any code change, always run the affected package's build and tests before committing:

```bash
pnpm --filter <package> build
pnpm --filter <package> test
# For changes that touch multiple packages:
pnpm build && pnpm test
```

All tests must be green before a commit is made.

### 2. Keep documentation in sync

Apply these documentation updates alongside every code change — not after the fact:

| What changed | What to update |
|---|---|
| New feature, new skill, new API endpoint, new adapter | `README.md` — add to the relevant section |
| Phase milestone reached or task completed | `implementation_plan.md` — mark checkbox, update phase status |
| New testable behavior, new endpoint, changed CLI usage | `TEST_INSTRUCTIONS.md` — add or update the relevant test case and checklist row |
| Routing logic, env vars, package roles, Next.js constraints | `CLAUDE.md` — update the affected section |

Do **not** update docs for internal refactors with no user-visible behavior change.

### 3. Commit after every logical change

Commit immediately after completing a self-contained change (feature, fix, doc update). Do not batch unrelated changes into one commit.

Commit message format:
```
<type>(<scope>): <short summary>

<optional body explaining why, not what>

Co-Authored-By: Claude Sonnet 4.6 <noreply@anthropic.com>
```

Types: `feat`, `fix`, `docs`, `refactor`, `test`, `chore`
Scope: package or app name — `core`, `registry`, `adapters`, `gateway`, `web`, `cli`, `ip-lookup`, etc.

Stage only relevant files — never use `git add -A` blindly. Do not commit `dist/`, `.env`, or `registry/ratings.json`.

### 4. Adding or modifying a skill

When adding a new skill or changing how an existing skill routes:

1. Update `isSkillEligible()` in `packages/core/src/router.ts` if the skill needs hard pre-filtering.
2. Smoke-test the `scripts/invoke.js` directly: `OCTOPUS_INPUT='{"query":"..."}' node registry/skills/<name>/scripts/invoke.js`
3. Reset `registry/ratings.json` entries for removed skills so stale data doesn't persist.
4. The web server caches the skill index at startup — restart it after adding/changing skills.
5. Add a test row to `TEST_INSTRUCTIONS.md`.

### 5. Phased development tracking

`implementation_plan.md` is the source of truth for project progress. When completing work from a phase:

- Check off the completed items with `[x]`
- Update the phase header from `⏳ Planned` → `✅ Complete`
- Update the test count in the Verification section

---

## Commands

```bash
pnpm install          # install all workspace dependencies
pnpm build            # build all packages (order: registry → adapters → core → gateway → apps)
pnpm test             # run all 35+ tests across all workspaces
pnpm dev              # watch mode for all packages in parallel

# Scoped commands
pnpm --filter @agentoctopus/core build
pnpm --filter @agentoctopus/core test
pnpm --filter web test

# Run a single test file
pnpm --filter @agentoctopus/registry exec vitest run tests/registry.test.ts

# CLI (must build first)
node apps/cli/dist/index.js list
node apps/cli/dist/index.js ask "What's the weather in Tokyo?"

# Web dev server
cd apps/web && pnpm dev   # http://localhost:3000
```

## Architecture

AgentOctopus is a **pnpm monorepo** (workspaces: `packages/*`, `apps/*`). All packages are ESM (`"type": "module"`), TypeScript targeting ES2022/NodeNext. Each package builds with `tsc` to its own `dist/`.

Published to npm under the `@agentoctopus/` scope, plus an `agentoctopus` umbrella package that re-exports everything.

### Request flow

```
User query
  → Gateway (CLI / REST API / IM bot / agent-protocol)
  → Router   — embeds query, cosine-scores against skill index,
               pre-filters with isSkillEligible(), LLM re-ranks,
               returns [] if no skill fits (→ direct LLM answer)
  → Executor — picks adapter (http / mcp / subprocess), invokes skill
  → Result   — formatted, returned to caller; feedback updates ratings.json
```

### Package responsibilities

| Package | Key files | Role |
|---|---|---|
| `packages/agentoctopus` | `index.ts` | Umbrella re-export of all sub-packages |
| `packages/registry` | `registry.ts`, `rating.ts`, `manifest-schema.ts` | Loads `SKILL.md` files via gray-matter + Zod, persists ratings/invocations to `registry/ratings.json` |
| `packages/core` | `router.ts`, `executor.ts`, `llm-client.ts` | Embedding index, cosine similarity, LLM re-rank, skill execution |
| `packages/adapters` | `http-adapter.ts`, `mcp-adapter.ts`, `subprocess-adapter.ts` | Three execution strategies — HTTP POST, MCP stdio, Node subprocess |
| `packages/gateway` | `engine.ts`, `session.ts`, `slack/discord/telegram.ts`, `agent-protocol.ts` | Shared engine bootstrap, 30-min session manager, IM bots, OpenClaw-compatible HTTP API |
| `apps/web` | `src/app/api/ask/route.ts`, `src/app/page.tsx` | Next.js REST API + chat demo UI |
| `apps/cli` | `src/index.ts` | Commander CLI (`list`, `ask`) with readline feedback prompt |

### Routing logic (critical to understand)

`router.ts` has two layers of filtering before a skill is chosen:

1. **`isSkillEligible(skill, query)`** — hard keyword/regex pre-filter per skill name. `ip-lookup` only passes through if the query contains an IPv4 address or domain pattern. `weather` requires weather keywords. `translation` requires translate keywords. All other skills pass through unconditionally.

2. **LLM re-rank** — sends top-K candidates to the chat LLM with a prompt that includes `"none"` as a valid answer. `parseRerankDecision()` handles fuzzy LLM output. If `"none"` is returned or the re-rank fails, `route()` returns `[]`.

When `route()` returns `[]`, callers (web API, agent-protocol, IM bots) fall back to answering directly with the chat LLM.

### Skills

Skills live in `registry/skills/<name>/SKILL.md` (gray-matter YAML frontmatter + markdown instructions) with an optional `scripts/invoke.js` for subprocess adapter. The Zod schema is in `packages/registry/src/manifest-schema.ts`.

Current real skills (all free APIs, no keys):
- **weather** — wttr.in
- **translation** — MyMemory API
- **ip-lookup** — ip-api.com (requires actual IP/domain in query)

### Environment

The web app symlinks `apps/web/.env → ../../.env`. Key variables:

```
EMBED_PROVIDER / EMBED_MODEL / EMBED_API_KEY / EMBED_BASE_URL  # for embedding
RERANK_MODEL                                                    # chat model for re-ranking
LLM_PROVIDER / LLM_MODEL / OPENAI_API_KEY / OPENAI_BASE_URL   # fallback direct-answer LLM
DEPLOY_MODE                                                     # "cloud" or "local" (default: local)
CLOUD_URL                                                       # cloud instance URL for skill sync (local mode)
SYNC_ON_STARTUP                                                 # auto-sync on boot (default: true)
```

Embedding and re-ranking can use a different provider/endpoint than the main LLM. The web `initOctopus()` in `apps/web/src/app/api/ask/route.ts` is a singleton — restart the server after changing skills or `.env`.

### Next.js specifics

- Config lives in `apps/web/next.config.mjs` only (`.ts` was removed).
- `@agentoctopus/adapters` must stay in `serverExternalPackages`, not `transpilePackages` — it uses Node-native APIs incompatible with the Turbopack bundler.
- `apps/web/AGENTS.md` warns that this Next.js version (16.x) has breaking API changes — read `node_modules/next/dist/docs/` before touching framework-level code.

### npm publishing

All packages are published to npm under the `@agentoctopus/` scope. The umbrella `agentoctopus` package re-exports everything. To publish a new version:

1. Bump version in each `package.json`
2. Build: `pnpm build`
3. Publish in dependency order: registry → adapters → core → gateway → cli → agentoctopus
4. Use `pnpm --filter <pkg> publish --no-git-checks`
