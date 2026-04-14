# Contributing Guidance Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Add a root-level `CONTRIBUTING.md` and `CODE_OF_CONDUCT.md` that match the approved contributing-guidance design and the repository's current contributor workflow.

**Architecture:** This change is documentation-only. `CODE_OF_CONDUCT.md` is a mostly verbatim policy document with one project-specific contact field, and `CONTRIBUTING.md` is a funnel-shaped contributor guide that points external contributors first toward skills work and only then toward core-engine changes. The guide must pull commands and constraints from source-of-truth files already in the repo so it does not repeat stale counts or outdated workflow details.

**Tech Stack:** Markdown, GitHub repository conventions, pnpm workspace commands, Contributor Covenant 2.1.

---

## File Map

| Action | File | Responsibility |
|---|---|---|
| Create | `CONTRIBUTING.md` | External contributor guide with skills-first funnel, branch/PR conventions, CI expectations, and help links |
| Create | `CODE_OF_CONDUCT.md` | Contributor Covenant 2.1 with the maintainer enforcement email filled in |
| Reference | `.github/workflows/ci.yml` | Source of truth for PR jobs and command names |
| Reference | `CLAUDE.md` | Source of truth for branch/commit/PR conventions already used by maintainers |
| Reference | `packages/registry/src/manifest-schema.ts` | Source of truth for required skill frontmatter fields |
| Reference | `TEST_INSTRUCTIONS.md` | Existing manual-test file that skill contributors must update |
| Reference | `docs/ARCHITECTURE.md` | Intended architecture and environment-variable reference mentioned by the spec, but currently absent in this checkout |
| Reference | `README.md` | Existing public project context; do not duplicate stale counts from other docs |

## Known Input Gap

The spec requires `CODE_OF_CONDUCT.md` to include the project maintainer's contact email, but no project-specific address is currently discoverable in the repo. Treat that as a required first input, not as a placeholder to leave behind in the finished file.

## Known Repo Mismatch

The approved design references `docs/ARCHITECTURE.md` and `docs/API.md` in the "Getting help" section, but neither file exists in the current checkout. Do not publish dead links in `CONTRIBUTING.md`. Resolve this one of two ways before merging:

1. Add those docs in a separate approved task, then keep the spec's links.
2. Replace those help-section links with existing source-of-truth docs already present in the repo, such as `README.md`, `CLAUDE.md`, or package READMEs.

## Task 1: Confirm the enforcement contact and create `CODE_OF_CONDUCT.md`

**Files:**
- Create: `CODE_OF_CONDUCT.md`

- [ ] **Step 1: Verify the file does not already exist**

Run:

```bash
cd /root/AgentOctopus && test ! -f CODE_OF_CONDUCT.md
```

Expected: exit code `0`.

- [ ] **Step 2: Obtain the maintainer enforcement email before writing the file**

Use the repository owner as the first lookup target, then ask for the value if it still is not available locally.

Run:

```bash
cd /root/AgentOctopus && git remote -v
```

Expected: the `origin` remote points at the canonical repository owner. If no maintainer email is documented in the repo, stop here and request the enforcement email from the maintainer before editing `CODE_OF_CONDUCT.md`.

- [ ] **Step 3: Create `CODE_OF_CONDUCT.md` using the Contributor Covenant 2.1 text**

Write the full Contributor Covenant 2.1 markdown into `CODE_OF_CONDUCT.md`, replacing only the enforcement contact email with the confirmed project address from Step 2.

Use this file header and enforcement section exactly:

```md
# Contributor Covenant Code of Conduct

## Our Pledge
```

And this enforcement paragraph format exactly:

```md
## Enforcement

Instances of abusive, harassing, or otherwise unacceptable behavior may be
reported to the community leaders responsible for enforcement at
<confirmed-maintainer-email>.
All complaints will be reviewed and investigated promptly and fairly.
```

And this attribution footer exactly:

```md
## Attribution

This Code of Conduct is adapted from the [Contributor Covenant][homepage],
version 2.1, available at
https://www.contributor-covenant.org/version/2/1/code_of_conduct.html.

[homepage]: https://www.contributor-covenant.org
```

Constraint: do not leave `<confirmed-maintainer-email>` or any other placeholder text in the saved file.

- [ ] **Step 4: Verify the finished file is project-specific and not a placeholder stub**

Run:

```bash
cd /root/AgentOctopus && rg -n "Contributor Covenant Code of Conduct|reported to the community leaders responsible for enforcement at|version 2.1" CODE_OF_CONDUCT.md
```

Expected: three matches, and the enforcement line contains the actual maintainer email rather than a placeholder.

- [ ] **Step 5: Commit the code-of-conduct file**

Run:

```bash
cd /root/AgentOctopus && git add CODE_OF_CONDUCT.md && git commit -m "docs: add contributor code of conduct"
```

Expected: one new file committed.

## Task 2: Create the root `CONTRIBUTING.md` funnel guide

**Files:**
- Create: `CONTRIBUTING.md`
- Reference: `CLAUDE.md`
- Reference: `.github/workflows/ci.yml`
- Reference: `packages/registry/src/manifest-schema.ts`
- Reference: `TEST_INSTRUCTIONS.md`
- Reference: `docs/ARCHITECTURE.md` if it exists by implementation time; otherwise use an existing doc with the same information

- [ ] **Step 1: Verify the file does not already exist**

Run:

```bash
cd /root/AgentOctopus && test ! -f CONTRIBUTING.md
```

Expected: exit code `0`.

- [ ] **Step 2: Draft the file with the required funnel structure**

Write this complete markdown into `CONTRIBUTING.md` and only adjust wording where needed to match the repository's exact current commands or file paths:

```md
# Contributing to AgentOctopus

Thanks for your interest in contributing to AgentOctopus. Skills are the primary contribution path for new contributors because they are isolated, easy to review, and do not require deep familiarity with the routing and execution internals.

Please read [CODE_OF_CONDUCT.md](CODE_OF_CONDUCT.md) before participating in issues, pull requests, or reviews.

## Choose a contribution path

There are two ways to contribute:

1. Add or improve a skill in `registry/skills/`
2. Change the core engine packages and applications

If you are new to the repository, start with a skill contribution first.

## Path 1: Contribute a skill

This is the default path for external contributors.

### Prerequisites

- Node.js 20 or newer
- `pnpm`
- A root `.env` file with working model credentials; point contributors to the repo's current environment-variable reference. Use `docs/ARCHITECTURE.md` only if that file exists at implementation time.

### Skill anatomy

Every skill lives under `registry/skills/<name>/`.

```text
registry/skills/<name>/
  SKILL.md
  scripts/invoke.js
```

- `SKILL.md` is required and must include valid frontmatter
- `scripts/invoke.js` is required for subprocess-backed skills

The `SKILL.md` frontmatter is validated by the Zod schema in `packages/registry/src/manifest-schema.ts`. The schema currently expects these core fields:

- `name`
- `description`
- `adapter`
- `tags`

### Checklist

1. Fork the repository on GitHub.
2. Create a branch from `master`:

   ```bash
   git checkout -b skill/<name>
   ```

3. Create `registry/skills/<name>/SKILL.md` with valid frontmatter and instructions.
4. If the skill uses the subprocess adapter, add `registry/skills/<name>/scripts/invoke.js`.
5. Smoke-test subprocess skills directly:

   ```bash
   OCTOPUS_INPUT='{"query":"..."}' node registry/skills/<name>/scripts/invoke.js
   ```

6. If the skill needs keyword pre-filtering, update `isSkillEligible()` in `packages/core/src/router.ts`.
7. Add or update the relevant row in `TEST_INSTRUCTIONS.md`.
8. Run the full workspace build and test suite:

   ```bash
   pnpm build && pnpm test
   ```

9. Commit using the conventions below.
10. Open a pull request against `master` that includes:
    - The skill name and what it does
    - The upstream API URL and any authentication requirements
    - Two or three example queries
    - Smoke-test output copied from the terminal

### What maintainers review for skill PRs

- `SKILL.md` passes schema validation
- `scripts/invoke.js` runs successfully when required
- Missing credentials fail with a clear, actionable error
- `TEST_INSTRUCTIONS.md` was updated
- CI is green

## Path 2: Contribute to the core engine

Core engine work is reviewable only after you understand the request flow through the registry, router, executor, gateway, and app entry points.

If you are new to AgentOctopus, open an issue first or start with a skill PR.

### Open an issue before implementation

Changes to routing logic, adapter behavior, or public API must be discussed in a GitHub issue before opening a pull request. This avoids shipping work that conflicts with the current project direction.

### Branch naming

Use a topic branch from `master`:

```bash
git checkout -b feat/<topic>
git checkout -b fix/<topic>
```

Never commit directly to `master`.

### Core-engine requirements

- `pnpm test` passes before you open the PR
- New behavior has automated test coverage in the affected package
- Update `CLAUDE.md` if routing logic, package responsibilities, or environment variables change
- Update `README.md` for user-visible behavior changes
- Update `TEST_INSTRUCTIONS.md` for new testable behavior
- CI passes before review

### Review expectations

Core engine pull requests require maintainer sign-off and usually take longer to review than skill contributions.

## Commit and pull request conventions

Use the same commit format already documented for maintainers:

```text
<type>(<scope>): <short summary>

<optional body - explain why, not what>
```

Supported commit types:

- `feat`
- `fix`
- `docs`
- `refactor`
- `test`
- `chore`

Supported scopes:

- `core`
- `registry`
- `adapters`
- `gateway`
- `web`
- `cli`
- a skill name such as `weather`

Do not commit:

- `dist/`
- `.env` files
- `registry/ratings.json`

Pull requests should explain what changed, why it is needed, and include smoke-test output for skill work.

## CI on pull requests

The workflow at `.github/workflows/ci.yml` runs automatically on pull requests targeting `master`.

Current jobs:

| Job | Command | What it checks |
|---|---|---|
| Lint | `pnpm -r lint` | Code style across all workspaces |
| Build | `pnpm -r --workspace-concurrency=1 build` | TypeScript compilation in dependency order |
| Test | `pnpm -r test` | All automated tests across all workspaces |

All CI jobs must pass before a maintainer reviews the pull request.

## Getting help

- Open a GitHub issue for questions, ideas, or to discuss a core-engine change before implementation
- `README.md` — project overview, bundled skills, environment setup
- `CLAUDE.md` — routing logic, package responsibilities, commit conventions, env vars
- `TEST_INSTRUCTIONS.md` — manual test coverage already expected in the repo
```

Constraints:

- Keep the doc skills-first.
- Do not quote stale test counts.
- Do not copy the outdated skill counts from `CLAUDE.md`.
- Keep the CI section aligned to `.github/workflows/ci.yml`, even if older docs say otherwise.
- Do not introduce links to files that do not exist in the checkout.

- [ ] **Step 3: Verify the skill-frontmatter guidance matches the schema**

Run:

```bash
cd /root/AgentOctopus && sed -n '1,120p' packages/registry/src/manifest-schema.ts
```

Expected: the schema still defines `name`, `description`, `adapter`, and `tags`, so the guidance above remains correct.

- [ ] **Step 4: Verify the CI commands and branch conventions against source files**

Run:

```bash
cd /root/AgentOctopus && sed -n '1,220p' .github/workflows/ci.yml
```

Expected: the workflow still runs lint/type-check, test, and build for pull requests targeting `master`.

Run:

```bash
cd /root/AgentOctopus && sed -n '1,140p' CLAUDE.md
```

Expected: the commit types, scopes, and `master` branch guidance still match the text copied into `CONTRIBUTING.md`.

- [ ] **Step 5: Verify that every help link in `CONTRIBUTING.md` points to a file that exists**

Run:

```bash
cd /root/AgentOctopus && rg -n "docs/ARCHITECTURE\\.md|docs/API\\.md|README\\.md|CLAUDE\\.md|TEST_INSTRUCTIONS\\.md" CONTRIBUTING.md
```

Expected: every referenced help doc exists in the checkout. If `docs/ARCHITECTURE.md` or `docs/API.md` are still absent, replace those links with existing docs before committing.

- [ ] **Step 6: Commit the contributing guide**

Run:

```bash
cd /root/AgentOctopus && git add CONTRIBUTING.md && git commit -m "docs: add contributing guide"
```

Expected: one new file committed.

## Task 3: Validate both docs as a coherent contributor entry point

**Files:**
- Modify: `CONTRIBUTING.md`
- Modify: `CODE_OF_CONDUCT.md`

- [ ] **Step 1: Verify the links, commands, and key phrases are present**

Run:

```bash
cd /root/AgentOctopus && rg -n "CODE_OF_CONDUCT\\.md|registry/skills/<name>|pnpm build && pnpm test|Never commit directly to `master`|\\.github/workflows/ci\\.yml|TEST_INSTRUCTIONS\\.md" CONTRIBUTING.md
```

Expected: matches for every required section and cross-reference.

- [ ] **Step 2: Verify no stale numeric claims were introduced**

Run:

```bash
cd /root/AgentOctopus && rg -n "\\b(35\\+|40\\+|86)\\b" CONTRIBUTING.md CODE_OF_CONDUCT.md
```

Expected: no matches.

- [ ] **Step 3: Verify the root docs now exist**

Run:

```bash
cd /root/AgentOctopus && ls CONTRIBUTING.md CODE_OF_CONDUCT.md
```

Expected:

```text
CODE_OF_CONDUCT.md
CONTRIBUTING.md
```

- [ ] **Step 4: Review and fix copy issues before the final docs commit**

Read both files end to end and correct any mismatch between:

- the skills path and actual repo paths
- the CI section and `.github/workflows/ci.yml`
- the skill-frontmatter guidance and `packages/registry/src/manifest-schema.ts`
- the code-of-conduct attribution and the final enforcement email

If any corrections are needed, amend the working tree and rerun Steps 1 through 3 of this task.

- [ ] **Step 5: Commit any remaining polish, if corrections were needed**

Only run this step if Step 4 found issues that were corrected. If both files were already correct, skip this step.

Run:

```bash
cd /root/AgentOctopus && git add CONTRIBUTING.md CODE_OF_CONDUCT.md && git commit -m "docs: finalize contributor-facing guidance"
```

Expected: wording-only fixes committed.

## Self-Review

### Spec coverage

- Root-level `CONTRIBUTING.md` is covered in Task 2.
- Root-level `CODE_OF_CONDUCT.md` is covered in Task 1.
- The skills-first funnel structure is covered in Task 2 Step 2.
- The core-engine issue-first gate is covered in Task 2 Step 2.
- Commit and PR conventions are covered in Task 2 Step 2 and verified in Task 2 Step 4.
- CI guidance is covered in Task 2 Step 2 and verified in Task 2 Step 4.
- Help links are covered in Task 2 Step 2 and verified against real files in Task 2 Step 5.
- Avoiding stale counts is covered by Task 2 Step 2 constraints and Task 3 Step 2.
- The missing maintainer email is called out explicitly as a required input in Task 1 instead of being left as a placeholder.
- The missing `docs/ARCHITECTURE.md` and `docs/API.md` files are called out explicitly so the final guide does not ship broken links.

### Placeholder scan

- No `TODO`, `TBD`, or "implement later" placeholders are left in the plan.
- The only unresolved item is the maintainer email, and the plan explicitly stops for that input instead of allowing a placeholder to ship.

### Type and terminology consistency

- Branch names consistently target `master`, matching the spec and current workflow targets.
- CI commands match `.github/workflows/ci.yml`.
- Skill guidance consistently references `registry/skills/<name>/SKILL.md`, `scripts/invoke.js`, `packages/core/src/router.ts`, and `TEST_INSTRUCTIONS.md`.

## Execution Handoff

Plan complete and saved to `docs/superpowers/plans/2026-04-14-contributing-guidance.md`. Two execution options:

**1. Subagent-Driven (recommended)** - I dispatch a fresh subagent per task, review between tasks, fast iteration

**2. Inline Execution** - Execute tasks in this session using executing-plans, batch execution with checkpoints

Which approach?
