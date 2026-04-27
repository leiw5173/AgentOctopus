# Adding Skills

Adding a new skill is the primary contribution path. It requires no changes to the core engine and is the best starting point for new contributors.

## Prerequisites

- **Node.js 22+** and **pnpm** installed globally (`npm install -g pnpm`)
- A `.env` file at the repo root with LLM credentials: `cp .env.example .env`

## Skill anatomy

Every skill lives in `registry/skills/<name>/` and consists of:

- **`SKILL.md`** — gray-matter YAML frontmatter followed by plain-English instructions for the LLM. The frontmatter is validated by the Zod schema in `packages/skills/src/schema.ts`.
- **`scripts/invoke.js`** (optional) — required for subprocess execution. Receives `OCTOPUS_INPUT` as a JSON env variable and writes the result to stdout.

Required frontmatter fields:

```yaml
---
name: <skill-name>
description: <one-sentence description used for semantic routing>
tags:
  - <tag1>
  - <tag2>
---
```

Optional eligibility fields (declared declaratively, no router code changes needed):

```yaml
os: [darwin, linux]
requires:
  bins: [curl]
  anyBins: [python3, python]
  env: [MY_API_KEY]
```

## Checklist

1. **Fork** the repository on GitHub.

2. Create a branch from `master`:

   ```bash
   git checkout master && git pull
   git checkout -b skill/<name>
   ```

3. Create `registry/skills/<name>/SKILL.md` with valid frontmatter (required fields: `name`, `description`).

4. If the skill needs scripts, add `scripts/invoke.js` (or `.py`/`.sh`) and smoke-test it:

   ```bash
   OCTOPUS_INPUT='{"query":"<example query>"}' node registry/skills/<name>/scripts/invoke.js
   ```

   Confirm the output is correct and that the script exits non-zero with a clear message when a required API key is missing.

5. If the skill needs runtime eligibility gates, declare them in SKILL.md frontmatter (`os`, `requires.bins`, `requires.env`, etc.). No router code changes needed.

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
