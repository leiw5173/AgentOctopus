---
title: Skills Index Bundle Design
date: 2026-04-13
status: approved
---

# Skills Index Bundle Design

## Goal

Replace the per-skill ClaWHub fetch loop in `octopus sync-awesome` with a single download of a pre-built, daily-refreshed index file. Result: 5,000+ skills install in ~10 seconds with zero rate-limit exposure. Missing API key detection added to the executor with a focused `octopus config` command for credential management.

## Problem

`octopus sync-awesome` currently fetches 5,000+ skills one-by-one from ClaWHub, hitting aggressive rate limits and taking hours. Users want fast (seconds) and reliable (never fails mid-sync).

## Approach

**Option B: Pre-built index on GitHub Releases (daily refresh)**

A GitHub Action builds a gzipped JSON index of all skills daily and uploads it to a fixed GitHub Release tag. `sync-awesome` downloads the index in one request and extracts skills locally. No ClaWHub calls at install time.

---

## Components

### 1. GitHub Action — Daily Index Build

**File:** `.github/workflows/build-skills-index.yml`

**Schedule:** Daily (`0 2 * * *` UTC — off-peak)

**Steps:**
1. Fetch all slugs from `awesome-openclaw-skills` using existing `fetchAwesomeSlugs()` logic
2. For each slug, download the full skill ZIP from ClaWHub (`GET /api/v1/download?slug=X&version=Y`) with generous delays between requests (server-side job, not user traffic — rate limits are not a concern here)
3. Extract from each ZIP:
   - `SKILL.md` — skill manifest
   - `_meta.json` — ClaWHub metadata (slug, version, publishedAt)
   - `scripts/invoke.js` — subprocess invoke script (nullable — not all skills have one)
4. Build `skills-index.json` with structure:
   ```json
   {
     "version": "1",
     "builtAt": "2026-04-13T02:00:00Z",
     "skills": [
       {
         "slug": "agent-commons",
         "name": "Agent Commons",
         "description": "...",
         "version": "1.0.3",
         "author": "zanblayde",
         "skillMd": "<full SKILL.md content>",
         "metaJson": "<full _meta.json content as string>",
         "invokeScript": "<full scripts/invoke.js content, or null>"
       }
     ]
   }
   ```
5. Gzip to `skills-index.json.gz`
6. Upload to GitHub Release tag `skills-index-latest` (overwrite previous asset)

**Release URL (fixed, never changes):**
```
https://github.com/leiw5173/AgentOctopus/releases/download/skills-index-latest/skills-index.json.gz
```

---

### 2. `sync-awesome` Command — Index-first with ClaWHub fallback

**File:** `apps/cli/src/index.ts` (sync-awesome action), `apps/cli/src/clawhub.ts` (new helpers)

**New flow:**
1. Download `skills-index.json.gz` from the fixed GitHub Release URL (one request, ~3–5MB)
2. Decompress and parse the JSON array in memory
3. Apply `--category`, `--limit`, `--force` filters locally (no extra network calls)
4. For each matching skill, write files to `<skillsDir>/<slug>/`:
   - `SKILL.md`
   - `_meta.json`
   - `scripts/invoke.js` (only if `invokeScript` is non-null in index)
5. **Fallback:** if index download fails (network error, asset not found), print a warning and fall back to the existing per-skill ClaWHub fetch path

**New helper functions in `clawhub.ts`:**
- `downloadSkillsIndex(url?: string): Promise<SkillIndexEntry[]>` — downloads, decompresses, parses the index
- `installFromIndex(entry: SkillIndexEntry, skillsDir: string, force?: boolean): void` — writes the three files to disk

**Index URL** stored as a constant `SKILLS_INDEX_URL` in `clawhub.ts`, pointing to the GitHub Release asset.

---

### 3. `octopus config` Command

**File:** `apps/cli/src/index.ts`

New top-level command with two subcommands:

```bash
octopus config set <KEY> <value>   # write key to ~/.agentoctopus/octopus.json + export to process.env
octopus config list                 # show all configured keys (values masked)
```

**Storage:** writes to `~/.agentoctopus/octopus.json` under a `credentials` key (same file used by `octopus onboard`).

**Immediate effect:** after `set`, the key is exported into `process.env` so the current session picks it up without restart.

---

### 4. Missing API Key Detection in Executor

**File:** `packages/core/src/executor.ts`

Before invoking a skill, the executor:
1. Reads `metadata.openclaw.env` from the skill's SKILL.md frontmatter (array of required env var names, e.g. `["COMMONS_API_KEY"]`)
2. Checks which are missing from `process.env`
3. If any are missing, throws a descriptive error instead of invoking:

```
✘ Skill "agent-commons" requires environment variables that are not set:

  COMMONS_API_KEY  — get yours at https://agentcommons.net

Run: octopus config set COMMONS_API_KEY <your-key>
```

The hint URL comes from `metadata.openclaw.homepage` in the frontmatter. If absent, the URL line is omitted.

**Error propagates** up to the CLI/gateway caller, which displays it to the user as a plain message (not a stack trace).

---

## Data Flow

```
GitHub Action (daily)
  → fetch slugs from awesome-openclaw-skills
  → fetch ZIPs from ClaWHub (server-side, no rate limit pressure)
  → build skills-index.json.gz
  → upload to GitHub Release (skills-index-latest)

octopus sync-awesome
  → download skills-index.json.gz (1 request, ~3-5MB)
  → decompress + filter in memory
  → write SKILL.md + _meta.json + scripts/invoke.js per skill
  → done in ~10 seconds

octopus ask "do X with agent-commons"
  → router selects agent-commons
  → executor checks metadata.openclaw.env
  → COMMONS_API_KEY missing → print hint → abort
  → user runs: octopus config set COMMONS_API_KEY abc123
  → user runs: octopus ask "do X with agent-commons" → succeeds
```

---

## File Map

| Action | File |
|--------|------|
| Create | `.github/workflows/build-skills-index.yml` |
| Create | `scripts/build-skills-index.js` (standalone Node ESM script, not part of pnpm workspace — invoked directly by the Action with `node scripts/build-skills-index.js`) |
| Modify | `apps/cli/src/clawhub.ts` — add `downloadSkillsIndex()`, `installFromIndex()`, `SKILLS_INDEX_URL` |
| Modify | `apps/cli/src/index.ts` — rewrite sync-awesome action, add `octopus config` command |
| Modify | `packages/core/src/executor.ts` — add missing env var check before invoke |

---

## Success Criteria

- `octopus sync-awesome` completes 5,000+ skills in under 30 seconds on a normal connection
- If the GitHub Release index is unavailable, `sync-awesome` falls back to ClaWHub with a visible warning
- When a skill requiring an API key is invoked without that key, a clear message with `octopus config set` instruction is shown
- `octopus config set KEY value` and `octopus config list` work correctly
- Existing `octopus add <slug>` (single skill install) is unchanged
- GitHub Action runs daily and the `skills-index-latest` release asset is updated
