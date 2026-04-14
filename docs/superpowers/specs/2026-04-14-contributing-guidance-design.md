---
title: Contributing Guidance Design
date: 2026-04-14
status: approved
---

# Contributing Guidance Design

## Overview

Two new files at the repository root:

- `CONTRIBUTING.md` — the primary contributing guide, funnel-structured for external OSS contributors
- `CODE_OF_CONDUCT.md` — Contributor Covenant 2.1, linked from CONTRIBUTING.md

No existing CONTRIBUTING.md exists. The design reflects the actual current state of the codebase (86 tests, 10 skills in registry) rather than outdated figures in CLAUDE.md.

---

## Document Structure

### CONTRIBUTING.md (funnel structure)

```
1. Welcome + link to CoC
2. Two contribution paths (skills vs core engine)
3. Skills path — primary, open to all (full checklist)
4. Core engine path — trust-gated, issue-first
5. Commit & PR conventions
6. CI/CD — what runs automatically on your PR
7. Getting help
```

### CODE_OF_CONDUCT.md

Standard Contributor Covenant 2.1 with project contact details.

---

## Section 1: Welcome

Short paragraph establishing that skills are the primary contribution path, with a link to CODE_OF_CONDUCT.md.

---

## Section 2: Skills Contribution Path

Target: any external contributor who wants to add a skill to the registry.

### Prerequisites

- Node.js 20+, pnpm
- A `.env` file with working LLM credentials (see `docs/ARCHITECTURE.md` for env vars)

### Anatomy of a skill

```
registry/skills/<name>/
  SKILL.md              # required — frontmatter + instructions
  scripts/invoke.js     # required if using subprocess adapter
```

`SKILL.md` frontmatter fields are validated against the Zod schema in `packages/registry/src/manifest-schema.ts`.

### Step-by-step checklist (strict)

1. Fork the repository on GitHub
2. Create a feature branch from `master`:
   ```bash
   git checkout -b skill/<name>
   ```
   Never commit directly to `master`.
3. Create `registry/skills/<name>/SKILL.md` with valid frontmatter (name, description, adapter, tags)
4. If using the subprocess adapter, write `scripts/invoke.js` and smoke-test it:
   ```bash
   OCTOPUS_INPUT='{"query":"..."}' node registry/skills/<name>/scripts/invoke.js
   ```
5. If the skill requires keyword pre-filtering, update `isSkillEligible()` in `packages/core/src/router.ts`
6. Add a test row to `TEST_INSTRUCTIONS.md`
7. Run the full build and test suite — all must pass:
   ```bash
   pnpm build && pnpm test
   ```
8. Commit with the conventional format (see Section 5)
9. Open a PR against `master` with:
   - Skill name and what it does
   - The API it calls (URL, auth requirements)
   - 2–3 example queries
   - Smoke-test output (copy/paste from terminal)

### What maintainers check

- SKILL.md passes schema validation
- `invoke.js` runs and returns a sensible result
- If the skill requires an API key: a graceful, actionable error is shown when the key is missing
- Test row is present in `TEST_INSTRUCTIONS.md`
- CI passes (lint → build → test)

---

## Section 3: Core Engine Contribution Path

Target: contributors with established familiarity with the codebase (router, executor, adapters, gateway, registry).

> If you're new to AgentOctopus, start with a skill contribution first. Core engine PRs require understanding the full request flow and existing test coverage.

### Open an issue first

Any change to routing logic, adapter behavior, or public API **must be discussed in a GitHub issue** before a PR is opened. This prevents wasted work on approaches that conflict with the project direction.

### Branch naming

```bash
git checkout -b feat/<topic>   # new feature
git checkout -b fix/<topic>    # bug fix
```

Never commit directly to `master`.

### Requirements

- All existing tests pass (`pnpm test`)
- New behavior is covered by tests in the affected package
- `CLAUDE.md` updated if routing logic, env vars, or package roles change
- `README.md` updated if user-visible behavior changes
- `TEST_INSTRUCTIONS.md` updated for any new testable behavior
- CI passes (lint → build → test)

### Review expectations

Core engine PRs require maintainer sign-off and may take longer to review than skill PRs. Expect at least one round of feedback.

---

## Section 4: Commit & PR Conventions

Pulled from the same rules used by maintainers (CLAUDE.md).

### Commit format

```
<type>(<scope>): <short summary>

<optional body — explain why, not what>
```

**Types:** `feat`, `fix`, `docs`, `refactor`, `test`, `chore`  
**Scope:** `core`, `registry`, `adapters`, `gateway`, `web`, `cli`, or skill name (e.g. `weather`)

### What not to commit

- `dist/` build output
- `.env` files
- `registry/ratings.json`

### PR description

Include enough context for a maintainer who hasn't seen your branch:
- What does this change do?
- Why is it needed?
- For skills: smoke-test output

---

## Section 5: CI/CD — What Runs on Your PR

The pipeline at `.github/workflows/ci.yml` runs automatically on every PR targeting `master`. All jobs must pass before a maintainer will review.

| Job | Command | What it checks |
|---|---|---|
| **Lint** | `pnpm -r lint` | Code style across all workspaces |
| **Build** | `pnpm -r build` | TypeScript compilation, topological order |
| **Test** | `pnpm -r test` | 86 tests across 6 packages |

For skill PRs, the maintainer additionally runs the smoke test locally before merging.

---

## Section 6: Getting Help

- Open a GitHub issue for questions, ideas, or to discuss a core engine change before writing code
- `docs/ARCHITECTURE.md` — package structure, configuration reference, env vars
- `docs/API.md` — REST endpoints, agent protocol
- `TEST_INSTRUCTIONS.md` — manual test cases for all features

---

## Implementation Notes

- Both files go at the repository root
- `CODE_OF_CONDUCT.md` uses Contributor Covenant 2.1 verbatim with the project maintainer's contact email filled in
- The test count (86) and skill list in the contributing guide should reference CI as source of truth, not be hardcoded — phrase it as "all tests pass" rather than citing a number that will drift
- CLAUDE.md contains outdated counts ("35+ tests", "40+ tests") and an incomplete skills list — these are not corrected as part of this task (no user-visible behavior change), but the contributing guide avoids repeating those stale figures
