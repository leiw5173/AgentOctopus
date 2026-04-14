# Contributing to AgentOctopus

Welcome! AgentOctopus is an open-source pnpm monorepo that routes natural-language queries to composable skills. The primary contribution path is **adding a new skill** — it requires no changes to the core engine and is the best starting point for new contributors. If you plan to modify the routing logic, adapters, or API surface, see [Path 2: Core engine](#path-2-core-engine) below.

Please read and follow our [CODE_OF_CONDUCT.md](CODE_OF_CONDUCT.md) before contributing.

---

## Choose a contribution path

| Path | What you build | Complexity | Who it's for |
|------|---------------|------------|--------------|
| [Path 1: Skill](#path-1-contribute-a-skill) | A new capability backed by any free or authenticated API | Low | New contributors, first-timers |
| [Path 2: Core engine](#path-2-core-engine) | Routing, adapters, gateway, CLI, or web app changes | High | Experienced contributors; open an issue first |

If you are new to the project, start with a skill.

---

## Path 1: Contribute a skill

### Prerequisites

- **Node.js 20+** and **pnpm** installed globally (`npm install -g pnpm`)
- A `.env` file at the repo root with LLM credentials. See [docs/ARCHITECTURE.md](docs/ARCHITECTURE.md) for the full list of required environment variables.

### Skill anatomy

Every skill lives in `registry/skills/<name>/` and consists of:

- **`SKILL.md`** — gray-matter YAML frontmatter followed by plain-English instructions for the LLM. The frontmatter is validated by the Zod schema in `packages/registry/src/manifest-schema.ts`.
- **`scripts/invoke.js`** (optional) — required when `adapter: subprocess` is set. Receives `OCTOPUS_INPUT` as a JSON env variable and writes the result to stdout.

Required frontmatter fields:

```yaml
---
name: <skill-name>
description: <one-sentence description used for semantic routing>
adapter: http | mcp | subprocess
tags:
  - <tag1>
  - <tag2>
---
```

### Checklist

Follow every step in order:

1. **Fork** the repository on GitHub.

2. Create a branch from `master` — never commit to master:
   ```bash
   git checkout master && git pull
   git checkout -b skill/<name>
   ```

3. Create `registry/skills/<name>/SKILL.md` with valid frontmatter (all four required fields: `name`, `description`, `adapter`, `tags`).

4. If using the subprocess adapter, add `scripts/invoke.js` and smoke-test it:
   ```bash
   OCTOPUS_INPUT='{"query":"<example query>"}' node registry/skills/<name>/scripts/invoke.js
   ```
   Confirm the output is correct and that the script exits non-zero with a clear message when a required API key is missing.

5. If the skill needs keyword pre-filtering (e.g., it should only activate when the query contains a specific pattern), update `isSkillEligible()` in `packages/core/src/router.ts`.

6. Add a row to `TEST_INSTRUCTIONS.md` describing at least one manual test case for your skill.

7. Run the full build and test suite — all must be green before opening a PR:
   ```bash
   pnpm build && pnpm test
   ```

8. Commit using the conventional format described in [Commit and PR conventions](#commit-and-pr-conventions).

9. Open a pull request against `master`. The PR description must include:
   - Skill name and what it does
   - The API URL(s) used and any authentication requirements
   - Two or three example queries the skill handles
   - The raw output of the smoke-test command from step 4

### What maintainers check

- Frontmatter passes Zod schema validation (checked automatically in tests)
- `scripts/invoke.js` runs and produces sensible output
- The script exits gracefully with a clear error when a required credential is absent
- A row is present in `TEST_INSTRUCTIONS.md`
- All CI jobs are green

---

## Path 2: Core engine

Changes to routing logic, adapters, the gateway, the CLI, or the web application are **trust-gated**. Maintainer review takes longer than for skill PRs.

**Before writing any code**, open a GitHub issue describing the problem and proposed solution. Wait for a maintainer to acknowledge the issue before starting work. This prevents duplicated effort and ensures the change fits the project direction.

### Branch naming

```bash
git checkout master && git pull
git checkout -b feat/<topic>   # for new features
git checkout -b fix/<topic>    # for bug fixes
```

Never commit directly to master.

### Requirements

- All existing tests must continue to pass.
- New behavior must be covered by new tests.
- Update `CLAUDE.md`, `README.md`, and `TEST_INSTRUCTIONS.md` wherever the change affects documented behavior.

### Review

A maintainer must sign off before the PR is merged. Plan for a longer review cycle than skill PRs.

---

## Commit and PR conventions

### Commit message format

```
<type>(<scope>): <short summary>

<optional body — explain why, not what>

Co-Authored-By: Claude Sonnet 4.6 <noreply@anthropic.com>
```

**Types:** `feat`, `fix`, `docs`, `refactor`, `test`, `chore`

**Scopes:** `core`, `registry`, `adapters`, `gateway`, `web`, `cli`, or the skill name (e.g., `weather`)

**Examples:**

```
feat(registry): add my-skill with subprocess adapter

fix(core): handle empty embedding response in router

docs(contributing): add smoke-test instructions
```

### Do not commit

- `dist/` — generated build output
- `.env` — credentials
- `registry/ratings.json` — runtime state, changes on every invocation

### PR description

Every PR should explain **what** changed and **why**. For skill PRs, also include the smoke-test output as described in the checklist above.

---

## CI on pull requests

The pipeline is defined in `.github/workflows/ci.yml`. Three jobs run automatically on every pull request to `master`. All three must pass before a PR is eligible for review.

| Job | Command | Notes |
|-----|---------|-------|
| Lint | `pnpm -r lint` | Runs first; build and test are skipped if this fails |
| Build | `pnpm -r --workspace-concurrency=1 build` | Runs after lint; builds all packages in topological order |
| Test | `pnpm -r test` | Runs after build; uses the build artifacts from the previous job |

For skill PRs, a maintainer will also run the smoke-test command locally after CI passes.

---

## Getting help

- **GitHub issues** — bug reports, feature requests, questions
- **[docs/ARCHITECTURE.md](docs/ARCHITECTURE.md)** — package structure, request flow, environment variables
- **[docs/API.md](docs/API.md)** — REST endpoints and agent protocol reference
- **[README.md](README.md)** — project overview and quickstart
- **[TEST_INSTRUCTIONS.md](TEST_INSTRUCTIONS.md)** — manual test cases and checklist
