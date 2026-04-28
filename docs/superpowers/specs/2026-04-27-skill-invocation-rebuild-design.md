# AgentOctopus Skill Invocation System Rebuild — Design Spec

**Date:** 2026-04-27
**Branch:** `feat/skill-invocation-rebuild`
**Reference:** OpenClaw skill system at `openclaw/openclaw@631552c`

## Overview

Comprehensive rebuild of the AgentOctopus skill invocation pipeline, modeled after OpenClaw's architecture. A new `packages/skills/` package is built greenfield, then wired into existing packages (core, registry, CLI), after which old code paths are removed.

## 1. Package Structure

New package `packages/skills/`:

```
packages/skills/src/
├── index.ts              # public API surface
├── types.ts               # SkillEntry, SkillInstallSpec, SkillMetadata, etc.
├── schema.ts              # Zod schema for SKILL.md frontmatter
├── frontmatter.ts         # parse + resolve metadata, invocation policy, install specs
├── config.ts              # resolveSkillConfig, shouldIncludeSkill, runtime eligibility
├── local-loader.ts        # load skills from a directory (SKILL.md glob)
├── workspace.ts           # multi-source load + priority merge + filter + snapshot
├── bundled.ts             # resolve bundled skills dir + load bundled context
├── install.ts             # SkillInstallSpec executor (brew, node, go, uv, download)
├── clawhub-install.ts     # ClaWHub install (moved from apps/cli)
├── command-specs.ts       # build slash-command specs from SkillEntry[]
├── env-overrides.ts       # apply per-skill env overrides (apiKey injection, ref counting)
├── snapshot.ts            # buildWorkspaceSkillSnapshot (prompt + limits + truncation)
├── plugin-skills.ts       # resolve plugin skill dirs (future plugin system)
└── refresh.ts             # FS watch + change notification
```

## 2. Pipeline Flow

```
SKILL.md files on disk (multiple sources)
    │
    ├─ 1. local-loader.ts → parse frontmatter → schema.validate()
    ├─ 2. frontmatter.ts  → resolve metadata, invocation policy, install specs
    ├─ 3. workspace.ts    → load from priority chain, merge by name
    ├─ 4. config.ts       → shouldIncludeSkill() on each entry
    │     ├─ config.enabled !== false?
    │     ├─ bundled allowlist check?
    │     ├─ OS match?
    │     ├─ required bins present?
    │     ├─ required env vars set?
    │     └─ required config paths truthy?
    ├─ 5. snapshot.ts     → build prompt XML, apply limits, truncate if needed
    ├─ 6. env-overrides.ts → inject per-skill env/apiKey
    └─ 7. command-specs.ts → generate slash commands
            │
            ▼
    SkillSnapshot { prompt, skills[], skillFilter?, resolvedSkills[] }
```

## 3. Frontmatter Schema

### SKILL.md Example

```yaml
name: weather
description: Get current weather and forecasts
version: "1.2.0"
emoji: "🌤️"
os: [darwin, linux]
primaryEnv: OPENWEATHER_API_KEY
always: false
homepage: https://openweathermap.org

requires:
  bins: [curl]
  anyBins: [python3, python]
  env: [OPENWEATHER_API_KEY]
  config: [browser.enabled]

install:
  - kind: brew
    formula: curl
    os: [darwin]
  - kind: node
    package: weather-cli

user-invocable: true
disable-model-invocation: false

openclaw:
  skillKey: weather-v2
  primaryEnv: OPENWEATHER_API_KEY
  os: [darwin, linux]
  requires:
    bins: [curl]
    env: [OPENWEATHER_API_KEY]
  install:
    - kind: brew
      formula: curl
```

### Design Decisions

- **Flat fields + `openclaw` block**: community skills use the `openclaw:` YAML key; either format is accepted. Resolution is per-field: for each field (`os`, `requires`, `install`, etc.), the flat (top-level) value wins if present; the `openclaw` block value is the fallback. This means a skill can declare `os` at top level and `requires` inside `openclaw` — they merge, not replace.
- **`install` vs `requires`**: `install` describes what the machine needs (package manager specs); `requires` describes runtime eligibility checks.
- **Permissive Zod schema**: `passthrough()` so community fields don't break parsing.
- **No old fields**: `adapter`, `endpoint`, `hosting`, `auth` are removed. Execution strategy is derived from directory contents (scripts/, MCP metadata), not declared.

### Core Types

```typescript
interface SkillInstallSpec {
  id?: string;
  label?: string;
  bins?: string[];
  kind: "brew" | "node" | "go" | "uv" | "download";
  os?: string[];
  formula?: string;       // brew
  package?: string;       // node
  module?: string;        // go
  url?: string;           // download
  archive?: string;
  extract?: boolean;
  stripComponents?: number;
  targetDir?: string;
}

interface SkillRequires {
  bins?: string[];
  anyBins?: string[];
  env?: string[];
  config?: string[];
}

interface SkillMetadata {
  always?: boolean;
  skillKey?: string;
  primaryEnv?: string;
  emoji?: string;
  homepage?: string;
  os?: string[];
  requires?: SkillRequires;
  install?: SkillInstallSpec[];
}

interface SkillInvocationPolicy {
  userInvocable: boolean;          // default true
  disableModelInvocation: boolean;  // default false
}

interface SkillEntry {
  skill: Skill;
  frontmatter: Record<string, string>;
  metadata: SkillMetadata;
  invocation: SkillInvocationPolicy;
  exposure?: SkillExposure;
}

interface SkillEligibilityContext {
  hasBin: (bin: string) => boolean;
  hasAnyBin: (bins: string[]) => boolean;
  hasEnv: (key: string) => boolean;
  isConfigPathTruthy: (path: string) => boolean;
  os: string;
  remote?: {
    platforms: string[];
    hasBin: (bin: string) => boolean;
    hasAnyBin: (bins: string[]) => boolean;
  };
}

interface SkillExposure {
  includeInRuntimeRegistry: boolean;
  includeInAvailableSkillsPrompt: boolean;
  userInvocable: boolean;
}

interface SkillSnapshot {
  prompt: string;
  skills: Array<{ name: string; primaryEnv?: string; requiredEnv?: string[] }>;
  skillFilter?: string[];
  resolvedSkills: Skill[];
  version: number;
}
```

## 4. Configuration System

### octopus.json — Skills Section

```jsonc
{
  "skills": {
    "allowBundled": ["weather", "translation"],
    "entries": {
      "weather": {
        "enabled": true,
        "apiKey": "${OPENWEATHER_API_KEY}",
        "env": { "DEBUG": "1" },
        "config": { "timeoutMs": 15000 }
      },
      "translation": { "enabled": false }
    },
    "load": {
      "extraDirs": ["/Users/sam/my-skills"],
      "watch": true,
      "watchDebounceMs": 500
    },
    "limits": {
      "maxSkillsInPrompt": 150,
      "maxSkillsPromptChars": 18000,
      "maxSkillFileBytes": 256000
    }
  }
}
```

### Config Resolution

- `resolveSkillConfig(config, skillKey)` — looks up `config.skills.entries[skillKey]`, returns `SkillConfig | undefined`.
- `skillKey` = `entry.metadata.skillKey ?? entry.skill.name`.

## 5. Eligibility Pipeline

`shouldIncludeSkill({ entry, config, eligibility })`:

```
1. skillKey = entry.metadata.skillKey ?? entry.skill.name
2. skillConfig = resolveSkillConfig(config, skillKey)
3. allowBundled = normalizeAllowlist(config.skills.allowBundled)

4. CHECK: skillConfig.enabled !== false       → if false, EXCLUDE
5. CHECK: isBundledSkillAllowed(entry, allowBundled)
   → if bundled + not in allowlist, EXCLUDE
6. CHECK: evaluateRuntimeEligibility(entry, eligibility):
   a. metadata.always === true                → PASS (bypass all)
   b. metadata.os set, OS not in list         → EXCLUDE
   c. metadata.requires.bins: any missing     → EXCLUDE
   d. metadata.requires.anyBins: none present → EXCLUDE
   e. metadata.requires.env: any missing      → EXCLUDE
   f. metadata.requires.config: any falsy     → EXCLUDE
   → PASS
```

**Bundled skill gating**: if `allowBundled` is empty/absent, all bundled skills are blocked. If non-empty, only skills whose `skillKey` or `name` is in the list pass. Non-bundled skills always pass this check.

**Default config values**: `browser.enabled` and `browser.evaluateEnabled` default to `true` when not explicitly set.

**Two call sites**: workspace loading (pre-route filter) and executor (per-invocation re-check).

## 6. Installation System

`installSkillDeps(entry, preferences?)`:

```
for each spec in entry.metadata.install:
  1. Skip if spec.os set and doesn't include current platform
  2. Skip if spec.bins are all already on PATH
  3. Dispatch by kind:
     brew     → spawn("brew", ["install", spec.formula])
     node     → spawn(prefs.nodeManager ?? "npm", ["install", "-g", spec.package])
     go       → spawn("go", ["install", spec.module])
     uv       → spawn("uv", ["tool", "install", spec.package])
     download → fetch(spec.url), extract, place in spec.targetDir
  4. Verify spec.bins now on PATH
  5. Return { installed: string[], skipped: string[], errors: string[] }
```

Install preferences: `preferBrew: boolean`, `nodeManager: "npm" | "pnpm" | "yarn" | "bun"`.

### ClaWHub Integration

Moved from `apps/cli/src/clawhub.ts` to `packages/skills/src/clawhub-install.ts`. Skills installed via ClaWHub get `source: "clawhub"` origin and integrate with the workspace priority chain (tier 3: managed).

### Input Validation

All string normalization functions reject: leading `-` (flag injection), `\\` and `..` (path traversal), and suspicious characters. Package/formula names are validated against per-kind regex patterns.

## 7. Bundled Skills

### Two Tiers

1. **Core bundled** — ships in the npm package at `packages/skills/bundled/`. Always available, no network. Initial set: `weather`, `translation`, `ip-lookup`.

2. **Optional skill packs** — fetched from GitHub Releases on first use. Configured via:
   ```json
   { "skills": { "packs": ["browser-automation", "data-analysis"] } }
   ```
   Downloaded to `~/.agentoctopus/skills-packs/`, loaded as source tier 5.

### Resolution

`resolveBundledSkillsDir()` checks:
1. `OCTOPUS_BUNDLED_SKILLS_DIR` env override
2. `<package root>/packages/skills/bundled/` (development)
3. `<npm package>/dist/bundled/` (installed)
4. Walk up from module directory (up to 6 levels) looking for `bundled/` with `.md` files or `SKILL.md` subdirectories

## 8. Workspace Priority Chain

| Priority | Source | Origin | Path |
|----------|--------|--------|------|
| 1 (highest) | Personal home | `"user"` | `~/.agents/skills/` |
| 2 | Workspace | `"project"` | `<cwd>/.agents/skills/` |
| 3 | Managed (ClaWHub) | `"clawhub"` | `~/.agentoctopus/skills/` |
| 4 | Plugin dirs | `"plugin"` | from plugin manifests |
| 5 | Skill packs | `"pack"` | `~/.agentoctopus/skills-packs/` |
| 6 (lowest) | Bundled core | `"bundled"` | package `bundled/` dir |

Higher priority overwrites lower priority by `skill.name`. Plugin dirs return `[]` until the plugin system is implemented.

### Limits

- `maxCandidatesPerRoot`: 300
- `maxSkillsLoadedPerSource`: 200
- `maxSkillsInPrompt`: 150
- `maxSkillsPromptChars`: 18,000
- `maxSkillFileBytes`: 256,000

Prompt truncation: if the full `<available_skills>` block exceeds the char budget, falls back to compact format (name + location only). If still over budget, binary search finds the largest prefix that fits.

## 9. Invocation Policies

| Field | Default | Effect |
|---|---|---|
| `userInvocable` | `true` | When `false`, hidden from slash commands and `--skill` autocomplete. LLM can still route. |
| `disableModelInvocation` | `false` | When `true`, LLM cannot auto-route. Omitted from `<available_skills>` prompt block. User must explicitly invoke. |

### Skill Exposure Derivation

- `includeInRuntimeRegistry` = passes `shouldIncludeSkill()`
- `includeInAvailableSkillsPrompt` = in registry AND NOT `disableModelInvocation`
- `userInvocable` = from frontmatter (default true)

## 10. Command Generation

`buildWorkspaceSkillCommandSpecs(entries)`:

1. Filter to `userInvocable === true` entries
2. Sanitize names: max 32 chars, lowercase + underscores
3. Deduplicate collisions via `_2`, `_3` suffix
4. Truncate descriptions to 100 chars
5. Attach dispatch specs for skills with `command-dispatch: tool` in frontmatter
6. Return `SkillCommandSpec[]`

CLI integration:
- `octopus <command>` — each skill becomes a subcommand
- `octopus ask --skill <name>` — works for all skills
- `octopus skill list` — shows user-invocable skills with their commands

## 11. Environment Overrides

`applySkillEnvOverrides(entries, config)` — before execution:

1. For each entry, resolve `primaryEnv` and required env vars
2. Look up `skillConfig.env` and `skillConfig.apiKey` from per-skill config
3. Inject into `process.env` with reference counting (`acquireActiveSkillEnvKey`)
4. Block dangerous keys: `/^OPENSSL_CONF$/i`
5. Return reverter function for cleanup after execution

## 12. Refresh System

- FS watcher on all source directories (when `config.skills.load.watch === true`)
- Bump snapshot version on change — listeners can re-fetch
- Debounce: `config.skills.load.watchDebounceMs` (default 500ms)
- `registerSkillsChangeListener(listener)` returns unsubscribe function

## 13. Existing Packages — Integration Changes

### `packages/registry`
- Remove manifest schema and SKILL.md loading (delegates to `@agentoctopus/skills`)
- Keep `RatingStore` and `rating-dimensions.ts`
- Rating data merged into SkillEntry by workspace loader

### `packages/core`
- `router.ts`: replace hardcoded `isSkillEligible()` with call to `shouldIncludeSkill` from skills package
- `executor.ts`: call `applySkillEnvOverrides` before invocation; call `shouldIncludeSkill` for per-invocation re-check
- `config-resolver.ts`: add `skills` section to config schema with defaults

### `apps/cli`
- Clawhub installation moved to `packages/skills`
- `sync-skills.ts` uses new workspace loader
- Command registration uses `buildWorkspaceSkillCommandSpecs`

## 14. Rating System Integration

The rating system is an AgentOctopus feature beyond OpenClaw — OpenClaw only does binary eligibility, while AgentOctopus uses historical quality metrics to prefer better-performing skills.

### Architecture

- `RatingStore` stays in `packages/registry` (dimensions, invocations, metrics, feedback)
- The workspace loader in `packages/skills` calls `RatingStore.getRoutingScore()` for each loaded skill and attaches the result to `SkillEntry`
- `SkillEntry` gains a `routingScore: number` field (0-1)
- The router in `packages/core` uses `routingScore` as a multiplier on cosine similarity

### Routing Score Computation

```
compositeScore = cosineSimilarity × routingScore
                 - negativeFeedbackPenalty (0.50 × negativeFeedbackCount)
                 - credentialPenalty (0.25 × missingCredentialClasses)
                 - binaryPenalty (0.25 × missingBins)
                 - catchAllPenalty (2.0 embedding path / 0.1 keyword path)
```

### Rating Dimensions (unchanged from current system)

| Dimension | Range | Type | Description |
|-----------|-------|------|-------------|
| `completion` | 0-1 | Objective | Success rate from auto-collected metrics |
| `quality` | 0-5 | Subjective | EMA of user feedback (thumbs up/down) |
| `reliability` | 0-1 | Objective | 1 - error rate from auto-collected metrics |
| `latency` | 0-1 | Objective | Normalized speed from auto-collected metrics |
| `tokenCost` | 0-1 | Objective | Cost efficiency from auto-collected metrics |

### Task-Type-Aware Weights

| Task Type | completion | quality | reliability | latency | tokenCost |
|-----------|-----------|---------|-------------|---------|-----------|
| one-shot | 0.30 | 0.25 | 0.20 | 0.15 | 0.10 |
| long-running | 0.25 | 0.20 | 0.30 | 0.10 | 0.15 |
| agent-collab | 0.20 | 0.30 | 0.25 | 0.10 | 0.15 |

### Feedback Collection

Survives unchanged: CLI thumbs up/down, web thumbs up/down, agent platform NLP sentiment detection. Each feedback event triggers an EMA update to the quality dimension and writes through to `ratings.json`.

### In the Routing Flow

```
1. workspace.ts loads skills → merges rating data → SkillEntry.routingScore populated
2. router.ts filters via shouldIncludeSkill (binary eligibility — ratings NOT involved)
3. router.ts ranks eligible skills via compositeScore (ratings ARE the multiplier)
4. LLM reranker receives top-K with scores → picks best or "none"
5. executor runs skill → auto-collects metrics → RatingStore.recordInvocationMetrics()
6. user gives feedback → RatingStore.recordFeedback() → routingScore updates for next time
```

This ensures higher-rated skills are naturally preferred by the router, while skills with a history of failures or negative feedback are deprioritized.

- Plugin system implementation (only directory resolution is built)
- Remote eligibility (wired in types but returns empty for now)
- MCP adapter changes (adapter inference logic already exists, just needs schema alignment)
- Rating system changes (already well-designed, just integrates with new SkillEntry type)

## 15. Constraints

- **No backward compatibility**: old SKILL.md format is not supported. All skills must use the new schema.
- **No soft-launch feature flags**: the old code is deleted, not if/else'd.
- **ClaWHub preserved**: ZIP download remains as a first-class install source alongside the 5 new methods.
- **Comprehensive test coverage required**: every new module in `packages/skills/` must have a corresponding test file.
