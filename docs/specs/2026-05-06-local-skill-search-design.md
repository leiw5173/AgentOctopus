# Local Skill Search — Design Spec

**Date:** 2026-05-06
**Branch:** `feature/local-skill-search`

## Overview

Replace the remote ClawHub `octopus search` command with a local, scored skill search. Add a `--run` flag for interactive pick-and-run execution.

## Motivation

- `octopus list` dumps all skills with no filtering
- `octopus ask` auto-picks one skill — no way to browse or choose manually
- `octopus search` hits the remote ClawHub marketplace, useless for local skills
- `registry.search()` already exists but uses naive substring matching and is not exposed to users

## Design

### 1. Shared scoring utility (`packages/skills/src/search.ts`)

Extract `scoreKeywordMatch()` and `extractQueryTokens()` from `router.ts` into a new module. These operate on a minimal interface (`{name, description, tags}` strings) to avoid circular dependencies.

```
extractQueryTokens(query: string): string[]
  - Splits Latin words (3+ chars) + CJK characters
  - Deduplicates

scoreKeywordMatch(tokens: string[], skill: {name, description, tags}): number
  - Word-boundary prefix matching
  - +2 for name match, +1 for description/tag match per token
```

**Exports:** `packages/skills/src/index.ts` re-exports both functions.

### 2. Enhanced `registry.search()` (`packages/registry/src/registry.ts`)

Replace the current `includes()` substring search with token extraction + scoring:

```
search(query: string): LoadedSkill[]
  1. tokens = extractQueryTokens(query)
  2. For each skill: score = scoreKeywordMatch(tokens, skill.manifest)
  3. Filter zero-score skills
  4. Sort by score descending
  5. Return
```

### 3. Router deduplication (`packages/core/src/router.ts`)

- Import `extractQueryTokens` and `scoreKeywordMatch` from `@agentoctopus/skills`
- Remove local copies (~50 lines: CJK_RANGE, extractQueryTokens, hasNonLatinChars, scoreKeywordMatch)
- `keywordFallback()` behavior unchanged

### 4. CLI `search` command (`apps/cli/src/index.ts`)

Replace the current remote ClawHub `search` command.

**`octopus search <query>` (default — display only)**
1. Bootstrap registry, call `registry.search(query)`
2. Print scored results: name, rating stars, description (truncated to 80 chars), tags, invocation count
3. Show hint: `Use --run to pick a skill and run a query`
4. No results: suggest `octopus list`

**`octopus search <query> --run` (interactive)**
1. Same search + display
2. Prompt: `Pick a skill (1-N, or Enter to cancel):`
3. Validate input, re-prompt on invalid
4. Prompt: `Query for <skill name> (or Enter to cancel):`
5. Execute via executor (same flow as `octopus ask`: retries, credential/binary guides, fallback)
6. Post-execution feedback prompt (same as `octopus ask`)

**`octopus search` (no query)**
- Error: `Provide a search query, e.g. "octopus search weather"`

**`octopus skill search <query>`** — alias, same behavior.

**Remote search preserved:** `searchSkills()` from `clawhub-install.ts` stays for `octopus onboard` flow.

### 5. Edge cases

| Case | Behavior |
|------|----------|
| No results | `No skills found for "xyz". Try "octopus list" to see all available skills.` |
| --run: invalid pick | `Invalid choice. Pick 1-N or press Enter to cancel.` Re-prompt. |
| --run: empty query | Cancel execution, exit cleanly. |
| --run: execution failure | Same retry/fallback as `octopus ask` (maxRetries, credential/binary guides, LLM fallback). |

## Files changed

| File | Change |
|------|--------|
| `packages/skills/src/search.ts` | **New** — `extractQueryTokens`, `scoreKeywordMatch` |
| `packages/skills/src/index.ts` | Add re-exports |
| `packages/core/src/router.ts` | Remove local copies (~50 lines), import from skills |
| `packages/registry/src/registry.ts` | Replace `includes()` search with scored search |
| `apps/cli/src/index.ts` | Replace `search` command: local search + `--run` mode |

## Docs to update

| Doc | Change |
|-----|--------|
| `README.md` | Add `octopus search` to CLI commands section |
| `CLAUDE.md` | Update `octopus search` description in Commands section |
| `TEST_INSTRUCTIONS.md` | Add test cases for `octopus search` and `octopus search --run` |
| `implementation_plan.md` | Mark relevant phase items |
| `docs/api-reference/cli-reference.md` | Update `octopus search` description + `--run` flag |
| `docs/api-reference/rest-api.md` | Note CLI `search` is now local; marketplace search is API-only |
| `docs/getting-started/quick-start.md` | Add `octopus search "weather"` example |
| `docs/superpowers/specs/2026-04-29-agentoctopus-openclaw-skill-design.md` | Update `octopus search` description |

## Tests

- `packages/skills/tests/search.test.ts` — token extraction, scoring edge cases
- `packages/registry/tests/registry.test.ts` — `search()` returns scored, sorted results
