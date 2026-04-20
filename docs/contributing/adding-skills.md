# Adding Skills

Adding a new skill is the primary contribution path. It requires no changes to the core engine and is the best starting point for new contributors.

## Prerequisites

- **Node.js 22+** and **pnpm** installed globally (`npm install -g pnpm`)
- A `.env` file at the repo root with LLM credentials: `cp .env.example .env`

## Skill anatomy

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

## Checklist

1. **Fork** the repository on GitHub.

2. Create a branch from `master`:
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

5. If the skill needs keyword pre-filtering, update `isSkillEligible()` in `packages/core/src/router.ts`.

6. Add a row to `TEST_INSTRUCTIONS.md` describing at least one manual test case.

7. Run the full build and test suite:
   ```bash
   pnpm build && pnpm test
   ```

8. Commit using the [conventional format](conventions.md).

9. Open a pull request against `master`. Include: skill name, API URLs, auth requirements, example queries, smoke-test output.

## What maintainers check

- Frontmatter passes Zod schema validation
- `scripts/invoke.js` runs and produces sensible output
- The script exits gracefully with a clear error when a required credential is absent
- A row is present in `TEST_INSTRUCTIONS.md`
- All CI jobs are green

## AI-assisted creation

```bash
octopus skill create          # interactive Q&A + LLM generation
octopus skill create --template  # blank template, no AI
```

See also: [Core Engine](core-engine.md) | [Conventions](conventions.md) | [Skills](../core-concepts/skills.md)
