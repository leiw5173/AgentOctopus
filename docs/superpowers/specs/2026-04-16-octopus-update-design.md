# `octopus update` & `octopus sync` (Replaced) — Design Spec

**Date:** 2026-04-16
**Status:** Draft

## Problem

AgentOctopus has no way to update its own npm packages or check for skill updates from the CLI. Users must manually run `npm install -g @agentoctopus/cli@latest` and re-run `sync-awesome` to get new skill versions. The existing `sync` command only syncs from a cloud instance — it has no marketplace version-checking.

## Solution

Two CLI commands:

1. **`octopus update`** — check and install latest `@agentoctopus/*` npm packages
2. **`octopus sync`** (replaced) — version-aware skill updates: check marketplace for newer versions of installed skills + cloud sync + bulk install from awesome-openclaw-skills (absorbs `sync-awesome`)

Both are self-contained in the CLI package (Approach A). No core package changes needed.

---

## `octopus update` — Update AgentOctopus npm Packages

### Command

```
octopus update [--check] [--yes]
```

### Flags

| Flag | Description |
|---|---|
| `--check` | Show available updates without installing (dry run) |
| `--yes`, `-y` | Skip confirmation prompt |

### Behavior

1. Query npm registry for latest versions of `@agentoctopus/cli` (and its workspace dependencies: registry, adapters, core, gateway)
2. Compare with currently installed versions (read from global `package.json` via `npm list -g --json` or the CLI's own `package.json`)
3. Display a table:

```
Package                    Current    Latest
@agentoctopus/cli          0.4.15     0.4.18
@agentoctopus/core         0.4.5      0.4.7
@agentoctopus/registry     0.4.7      0.4.8
```

4. If `--check`: stop here (exit 0 if up to date, exit 1 if updates available)
5. If updates available and not `--yes`: prompt "Update N packages? [y/N]"
6. Run `npm install -g @agentoctopus/cli@latest` — this pulls in all workspace deps transitively
7. Show success message with updated versions

### Error Handling

| Scenario | Output |
|---|---|
| No internet / npm unreachable | "Cannot reach npm registry. Check your connection." |
| Not installed globally | "AgentOctopus CLI is not installed globally. Use `npm install -g @agentoctopus/cli` first." |
| Already up to date | "All packages are up to date." with exit 0 |
| Install fails | Per-package error message with npm stderr |

### Implementation

New file `apps/cli/src/update.ts` with:
- `checkPackageUpdates()` — queries npm registry, returns `{ package, current, latest }[]`
- `runUpdate()` — runs `npm install -g`, shows results

The `update` command in `index.ts` calls these functions.

---

## `octopus sync` — Version-Aware Skill Updates (Replaced)

### Command

```
octopus sync [--cloud-url <url>] [--category <name>] [--limit <n>] [--force] [--dry-run] [--check] [--registry <url>]
```

### Flags

| Flag | Description |
|---|---|
| `--cloud-url <url>` | Cloud AgentOctopus instance URL (same as current) |
| `--category <name>` | Install only skills from one category (from `sync-awesome`) |
| `--limit <n>` | Maximum number of skills to install (from `sync-awesome`) |
| `--force` | Overwrite existing skills even if versions match |
| `--dry-run` | Preview what would happen without making changes |
| `--check` | Show available skill updates without installing |
| `--registry <url>` | Custom ClaWHub registry URL (from `sync-awesome`) |

### Behavior (Three-Phase)

**Phase 1 — Marketplace version check (update installed skills):**

1. Scan `~/.agentoctopus/skills/` (or `REGISTRY_PATH`) for installed skills
2. For each skill with a `version` field in its SKILL.md frontmatter, check the ClaWHub skills index (same source as `sync-awesome`) for a newer version
3. Collect list: `{ slug, currentVersion, latestVersion }[]`
4. If `--check`: display updates available and stop
5. For each updatable skill, download and replace SKILL.md + scripts from marketplace

**Phase 2 — Awesome skills bulk install (absorbs `sync-awesome`):**

6. Download the skills index from ClaWHub
7. Apply `--category` and `--limit` filters (same logic as current `sync-awesome`)
8. For each skill not already installed (or `--force`), install from index
9. This replaces the standalone `sync-awesome` command entirely

**Phase 3 — Cloud sync (existing `syncFromCloud` logic):**

10. If `--cloud-url` is provided, run existing `syncFromCloud()` to pull skills from cloud
11. This handles unversioned skills and cloud-only skills that aren't in the marketplace

### Output

```
Skill updates available:
  x-search  1.0.0 → 1.2.0
  weather   2.0.0 → 2.1.0

Awesome skills installed:
  [1/42] ✔ new-skill
  [2/42] – existing-skill (already installed, use --force to overwrite)

Cloud sync (from https://cloud.example.com):
  Added: cloud-skill
  Updated: x-search
  Skipped: translation (up to date)

Updated 4 skill(s). Restart the server to pick up changes.
```

### Backward Compatibility

- `--cloud-url` keeps the existing cloud-sync behavior working
- `--category`, `--limit`, `--registry` provide the `sync-awesome` behavior without a separate command
- Without any flags, Phase 1 (version check) and Phase 2 (awesome bulk install) both run
- `--force` works across all phases
- `sync-awesome` command is removed — users migrate to `octopus sync`

### Implementation

New file `apps/cli/src/sync-skills.ts` with:
- `checkSkillUpdates(skillsDir)` — scans installed skills, queries ClaWHub skills index for newer versions
- `updateSkills(updates, skillsDir)` — downloads and replaces updated skills
- `installAwesomeSkills(options)` — bulk install from awesome-openclaw-skills (extracted from current `sync-awesome` handler)
- Reuses existing `syncFromCloud()` from `@agentoctopus/registry`

The `sync` command in `index.ts` is replaced to call these functions. The `sync-awesome` command is removed.

---

## Files to Change

| File | Change |
|---|---|
| `apps/cli/src/index.ts` | Add `update` command, replace `sync` command handler, remove `sync-awesome` command |
| `apps/cli/src/update.ts` | **New** — npm registry check + install logic |
| `apps/cli/src/sync-skills.ts` | **New** — marketplace version check + awesome bulk install + cloud sync orchestration |
| `CLAUDE.md` | Add `update` command to Commands section, update Architecture table |
| `README.md` | Document `octopus update` and revised `octopus sync` |
| `TEST_INSTRUCTIONS.md` | Add test rows for both commands |

## Out of Scope

- Auto-update on startup (could be a future `--auto` flag)
- Rollback / downgrade
- Updating skills from git sources (only marketplace + cloud)
- Web UI or gateway integration for updates
