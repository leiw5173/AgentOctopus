# Design: Bundled Skills & `octopus skill create`

**Date:** 2026-04-03  
**Status:** Approved

---

## Goals

1. **Bundled skills** — users who install `@agentoctopus/cli` globally get working skills immediately, without cloning the repo or setting up a project directory.
2. **User-controlled skill home** — skills live in a user-chosen directory (default `~/.agentoctopus/skills/`), persisted across projects.
3. **Easy skill creation** — `octopus skill create` guides users through building a new skill, optionally using their configured LLM to draft the manifest.

---

## Section 1: Bundled Skills & User Home Directory

### 1.1 CLI package layout

A new `skills/` directory is added inside `apps/cli/`, included in the npm package via `"files"` in `package.json`:

```
apps/cli/
  skills/
    weather/
      SKILL.md
      scripts/invoke.js
    translation/
      SKILL.md
      scripts/invoke.js
    ip-lookup/
      SKILL.md
      scripts/invoke.js
    x-search/
      SKILL.md
      scripts/invoke.js
  package.json    ← "files": ["README.md", "dist", "skills"]
```

These are direct copies of the existing `registry/skills/` contents. The `registry/skills/` directory in the monorepo remains the source of truth during development; the CLI's `skills/` is what gets shipped to npm consumers.

### 1.2 User home directory

```
~/.agentoctopus/
  skills/          ← active skill registry (user-owned)
  ratings.json     ← persisted ratings
  octopus.json     ← machine-level config (skillsDir, ratingsPath, credentials)
```

`octopus.json` schema:
```json
{
  "skillsDir": "/home/user/.agentoctopus/skills",
  "ratingsPath": "/home/user/.agentoctopus/ratings.json",
  "credentials": {
    "X_API_KEY": "...",
    "OTHER_KEY": "..."
  }
}
```

Credentials for skills that require API keys are stored here (not in `.env`, which is project-level).

### 1.3 `bootstrap()` resolution order

The `skillsDir` and `ratingsPath` are resolved with this priority:

1. `REGISTRY_PATH` / `RATINGS_PATH` env vars (existing, power-user override)
2. `~/.agentoctopus/octopus.json` → `skillsDir` / `ratingsPath`
3. `process.cwd()/registry/skills` (legacy project-level fallback)

A new `loadOctopusConfig()` helper in `apps/cli/src/config.ts` handles reading/writing `octopus.json`.

### 1.4 Onboarding changes

A new **Step 0: Skills Directory** is inserted before the existing LLM config step (total steps becomes 6):

```
Where should AgentOctopus store your skills?
  Path: [~/.agentoctopus/skills]
```

After the user confirms the path:
- The directory is created if it doesn't exist.
- Bundled skills are copied from the CLI package's own `skills/` directory (`__dirname/../skills/`).
- Existing skill directories are **not overwritten** unless the user confirms per-skill.

The path is written to `~/.agentoctopus/octopus.json`.

### 1.5 Skill selection with credential prompting

Onboarding's skill selection step (now Step 5) is enhanced:

- Skills that declare `credentials` in their `SKILL.md` frontmatter are shown with a `🔑` indicator.
- If a user enables a credential-required skill, the wizard immediately prompts for each required key (using `password()` from `@inquirer/prompts`).
- Collected credentials are written to `octopus.json` under `credentials`.
- At runtime, `bootstrap()` merges `octopus.json` credentials into `process.env` before executing skills so `scripts/invoke.js` files can read them as normal env vars.

### 1.6 SKILL.md credentials frontmatter

The `SKILL.md` frontmatter supports a new optional `credentials` field:

```yaml
credentials:
  - key: X_API_KEY
    label: "X (Twitter) API Bearer Token"
    required: true
```

`SkillManifestSchema` in `packages/registry/src/manifest-schema.ts` is extended:

```ts
credentials: z.array(z.object({
  key: z.string(),
  label: z.string(),
  required: z.boolean().default(true),
})).optional()
```

---

## Section 2: `octopus skill create`

### 2.1 Command surface

```bash
octopus skill create              # AI-assisted interactive wizard
octopus skill create --template   # scaffold only, no AI
```

Both commands write the new skill into the user's configured skills directory:
`<skillsDir>/<name>/`

### 2.2 AI-assisted wizard flow

```
Step 1: What does your skill do?
         → free text description

Step 2: How does it work?
         → "Calls an external API" or "LLM-only (no external calls)"

  If external API:
    Step 3a: What is the API endpoint URL? (optional, can leave blank)
    Step 3b: What authentication does it need? (none / api_key / bearer / oauth)
    Step 3c: Describe a sample input and output

  If LLM-only:
    Step 3: Any constraints, tone, or output format requirements?

Step 4: [AI generates SKILL.md draft]
         → Calls user's configured LLM with a structured prompt
         → Shows the generated SKILL.md in the terminal

Step 5: Does this look right?
         → "Yes" — proceed
         → "Edit" — open in $EDITOR or allow inline field editing
         → "Regenerate" — re-run AI with additional user notes

Step 6: [If external API] Generate scripts/invoke.js stub
         → Templated fetch call with placeholders filled from above answers

Step 7: Write files, show confirmation with path
```

The LLM prompt for Step 4 is a system prompt that instructs the model to produce valid `SKILL.md` YAML frontmatter + instructions body, using the collected answers as context. The output is parsed and validated against `SkillManifestSchema` before writing.

### 2.3 `--template` flag flow

No prompts, no AI. Writes two files immediately:

**`SKILL.md`:**
```markdown
---
name: my-skill
description: Describe what this skill does.
tags: [example]
version: 1.0.0
adapter: subprocess
hosting: local
auth: none
input_schema:
  query: string
output_schema:
  result: string
---

## Instructions

Describe how the skill should behave. The router uses this text to decide
when to invoke the skill.
```

**`scripts/invoke.js`:**
```js
#!/usr/bin/env node
// TODO: implement your skill logic here
const input = JSON.parse(process.env.OCTOPUS_INPUT || '{}');
const { query } = input;

// Example: fetch from an external API
// const res = await fetch(`https://api.example.com?q=${query}`);
// const data = await res.json();

console.log(JSON.stringify({ result: 'TODO' }));
```

### 2.4 `octopus skill` subcommand group

The existing top-level `add`, `remove`, `search`, `publish` commands that relate to skills are reorganized under an `octopus skill` subcommand group for discoverability:

```
octopus skill create    ← new
octopus skill add       ← was: octopus add
octopus skill remove    ← was: octopus remove
octopus skill search    ← was: octopus search
octopus skill publish   ← was: octopus publish
octopus skill list      ← was: octopus list
```

Old top-level aliases (`octopus add`, `octopus list`, etc.) are kept for backwards compatibility.

---

## Affected Files

| File | Change |
|---|---|
| `apps/cli/skills/` | New directory — bundled skill copies |
| `apps/cli/package.json` | Add `"skills"` to `"files"` |
| `apps/cli/src/config.ts` | New — `loadOctopusConfig()`, `saveOctopusConfig()` |
| `apps/cli/src/onboard.ts` | Add Step 0 (skills dir), credential prompting in skill selection |
| `apps/cli/src/index.ts` | Add `skill` subcommand group, `octopus skill create` |
| `apps/cli/src/skill-create.ts` | New — AI wizard + `--template` scaffold logic |
| `packages/registry/src/manifest-schema.ts` | Add `credentials` field to `SkillManifestSchema` |
| `registry/skills/*/SKILL.md` | Add `credentials` where needed (e.g. x-search) |
| `README.md` | Document bundled skills, `octopus skill create`, `octopus.json` |
| `TEST_INSTRUCTIONS.md` | Add test cases for onboarding flow, skill create |
| `implementation_plan.md` | Mark new phase |

---

## Out of Scope

- Syncing user-created skills back to ClaWHub (separate feature)
- Multi-user or team skill sharing
- Skill versioning / update checks for bundled skills
