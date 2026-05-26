# Skill Binary Auto-Install Design

**Date:** 2026-05-21
**Scope:** AgentOctopus skill execution pipeline
**Goal:** When a matched skill requires missing binaries, prompt the user for installation, install automatically if confirmed, and continue execution.

---

## 1. Problem

Currently, when `Executor.execute()` detects missing binaries required by a skill, it returns a hard `BinaryMissingResult` that all callers (CLI, Web API, REST API, Slack/Discord/Telegram) display as a static error:

```json
{
  "success": false,
  "type": "binary_missing",
  "skillName": "openmeteo-sh-weather-simple",
  "missing": ["openmeteo"],
  "response": "I matched a skill but it requires tools that aren't installed:\n  - openmeteo\n\nInstall the tool(s) above, then retry."
}
```

The user must manually install the missing tool and retry the query.

## 2. Architecture

```
Router ──▶ Executor.execute(skill, input, { autoInstall? })
                    │
         ┌──────────┴──────────┐
         ▼                     ▼
   bins available        bins missing
         │                     │
         │            ┌────────┴────────┐
         │            ▼                 ▼
         │     has install specs    no install specs
         │            │                 │
         │     ┌──────┴──────┐          │
         │     ▼             ▼          │
         │  autoInstall    prompt     return
         │   === true      needed     BinaryMissingResult
         │     │             │
         │     ▼             ▼
         │  Installer    return BinaryInstallableResult
         │  .execute()   (caller prompts user)
         │     │
         │  ┌──┴──┐
         │  ▼     ▼
         │  OK   FAIL
         │  │     │
         │  │     ▼
         │  │  return BinaryInstallFailedResult
         │  │  (manual instructions + fallback)
         │  │
         ▼  ▼
    continue skill execution
```

### New / modified files

| File | Change |
|---|---|
| `packages/skills/src/installer.ts` | **New** — parses `install` specs and executes platform-specific installation |
| `packages/skills/src/types.ts` | Export `SkillInstallSpec` type |
| `packages/core/src/executor.ts` | New result types; `execute()` gains `autoInstall` option |
| `packages/core/src/config-resolver.ts` | Add `installPrefs` read/write helpers |
| `packages/gateway/src/agent-protocol.ts` | Two-phase REST flow with session-pending state |
| `packages/gateway/src/channels/channel-handler.ts` | Chat-channel message-based confirmation |
| `packages/gateway/src/session.ts` | Support `pendingInstall` metadata on messages |
| `apps/cli/src/index.ts` | Interactive CLI prompt with always/never options |
| `apps/web/src/app/api/ask/route.ts` | Web API adapter for install-prompt flow |
| `registry/skills/openmeteo-sh-weather-simple/SKILL.md` | Add `install` declaration |

## 3. Core Types

### New result types

```typescript
export interface BinaryInstallableResult {
  type: 'binary_installable';
  skillName: string;
  missing: string[];
  installSpecs: SkillInstallSpec[];
}

export interface BinaryInstallFailedResult {
  type: 'binary_install_failed';
  skillName: string;
  missing: string[];
  error: string;
  manualInstructions: string[];
}
```

`Executor.execute()` return type becomes:

```typescript
Promise<
  | ExecutionResult
  | CredentialMissingResult
  | BinaryMissingResult          // unchanged — when no install specs exist
  | BinaryInstallableResult      // new — caller should prompt user
  | BinaryInstallFailedResult    // new — auto-install was attempted but failed
>
```

### User preference storage

Stored in `~/.agentoctopus/octopus.json` under a new top-level key:

```json
{
  "installPrefs": {
    "openmeteo": "always",
    "some-tool": "never"
  }
}
```

- Key = binary name (from `requires.bins`)
- Value = `"always" | "never" | "prompt"`
- Default for unknown tools = `"prompt"`

Helper functions in `config-resolver.ts`:

```typescript
export function getInstallPref(bin: string): 'always' | 'never' | 'prompt';
export function saveInstallPref(bins: string[], preference: 'always' | 'never'): void;
```

## 4. Installer Service (`packages/skills/src/installer.ts`)

Leverages the existing `SkillInstallSpec` schema already defined in `packages/skills/src/schema.ts`:

```typescript
interface SkillInstallSpec {
  id?: string;
  label?: string;
  bins?: string[];
  kind: 'brew' | 'node' | 'go' | 'uv' | 'download';
  os?: string[];
  formula?: string;
  package?: string;
  module?: string;
  url?: string;
  archive?: string;
  extract?: boolean;
  stripComponents?: number;
  targetDir?: string;
}
```

### Installation dispatch

| `kind` | Command built |
|---|---|
| `brew` | `brew install <formula \| package>` |
| `node` | `npm install -g <package>` |
| `go` | `go install <module>` |
| `uv` | `uv tool install <package>` |
| `download` | `curl -L <url>` → extract if needed → move to `targetDir` |

### Filtering logic

1. **OS filter**: Skip specs whose `os` array does not include the current platform (`darwin`, `linux`, `win32`).
2. **Bin filter**: Only install specs whose `bins` intersect with the actually-missing binaries.
3. **Deduplication**: If multiple specs target the same missing bin, execute only the first match.

### Download kind details

- If `extract` is true, detect archive format from `archive` or URL extension (`.tar.gz`, `.zip`, etc.).
- Use `stripComponents` for tar extraction (default 1 for GitHub releases).
- Default `targetDir` = `~/.local/bin`; create if missing.
- After extraction/move, ensure the binary is executable (`chmod +x`).

### Return value

```typescript
export interface InstallAttempt {
  bin: string;
  spec: SkillInstallSpec;
  command: string;
  success: boolean;
  error?: string;
}

export interface InstallResult {
  success: boolean;           // true if ALL missing bins were installed
  installed: string[];        // bins successfully installed
  failed: InstallAttempt[];   // bins that failed
  manualInstructions: string[];
}

export async function installMissingBins(
  specs: SkillInstallSpec[],
  missing: string[],
  platform: string,
): Promise<InstallResult>;
```

`manualInstructions` is generated per failed spec:
- For `brew` → `brew install <formula>`
- For `node` → `npm install -g <package>`
- For `download` → `curl -L <url> -o <file>` + extraction steps

## 5. Executor Changes

`execute()` signature:

```typescript
async execute(
  skill: LoadedSkill,
  input: Record<string, unknown>,
  opts: { debug?: boolean; autoInstall?: boolean } = {},
): Promise<ExecutionResult | CredentialMissingResult | BinaryMissingResult | BinaryInstallableResult | BinaryInstallFailedResult>
```

### Binary check logic (replaces lines 195–200)

```
1. Check required binaries
2. missingBins = requiredBins.filter(bin => !isBinAvailable(bin))
3. If missingBins.length === 0 → continue to execution
4. If missingBins.length > 0:
   a. installSpecs = skill.manifest.install ?? skill.manifest.openclaw?.install ?? []
   b. If installSpecs.length === 0 → return BinaryMissingResult (backward compatible)
   c. If opts.autoInstall === true:
      - result = await installMissingBins(installSpecs, missingBins, process.platform)
      - If result.success → re-check isBinAvailable, then continue
      - If !result.success → return BinaryInstallFailedResult
   d. If opts.autoInstall !== true → return BinaryInstallableResult
```

**Important**: The Executor does NOT read user preferences. Callers decide whether to pass `autoInstall: true` based on preference lookup.

## 6. REST API Two-Phase Flow (`agent-protocol.ts`)

### Phase 1 — Detect installable

When `execute()` returns `BinaryInstallableResult`:

1. Store pending state in session metadata:
   ```typescript
   sessionManager.addMessage(session, {
     role: 'assistant',
     content: `pending_install:${skillName}`,
     timestamp: Date.now(),
     skillUsed: skillName,
     metadata: {
       pendingInstall: true,
       skillName,
       input,
       missing,
       installSpecs,
     },
   });
   ```

2. Return JSON response:
   ```json
   {
     "success": false,
     "type": "install_prompt",
     "skillName": "openmeteo-sh-weather-simple",
     "missing": ["openmeteo"],
     "response": "技能 \"openmeteo-sh-weather-simple\" 需要以下工具，但尚未安装：\n  - openmeteo\n\n是否自动安装？（回复 \"yes\" 确认，或 \"no\" 跳过）",
     "sessionId": "...",
     "confidence": 0.14
   }
   ```

### Phase 2 — User confirms

On the next `POST /agent/ask` with the same `sessionId`:

1. Before routing, check if the last assistant message has `metadata.pendingInstall === true`.
2. If yes, parse the user's reply:
   - `"yes"` / `"y"` → clear pending, call `execute(skill, input, { autoInstall: true })`, continue
   - `"no"` / `"n"` → save `"never"` preference for missing bins, clear pending, try next candidate skill
   - Any other text → treat as a new query (clear pending, normal flow)

### Auto-apply preferences

Before returning `install_prompt`, check `getInstallPref()` for each missing bin:
- If **all** are `"always"` → skip Phase 1, directly call `execute(..., { autoInstall: true })`
- If **any** is `"never"` → skip this skill, try next candidate
- Otherwise → proceed to Phase 1 prompt

## 7. CLI Interactive Prompt (`apps/cli/src/index.ts`)

Inside the candidate-skill retry loop, when `result.type === 'binary_installable'`:

```
┌─────────────────────────────────────────┐
│ 技能 "openmeteo-sh-weather-simple" 需要 │
│ 以下工具，但尚未安装：                   │
│   • openmeteo                           │
│                                         │
│ 是否自动安装？ (yes/no/always/never):   │
└─────────────────────────────────────────┘
```

| User input | Action |
|---|---|
| `yes` / `y` | Execute `installMissingBins()`, then retry this skill |
| `no` / `n` | Try next candidate skill |
| `always` | Save `"always"` preference for all missing bins, then install + retry |
| `never` | Save `"never"` preference for all missing bins, then try next candidate |

After installation, check result:
- Success → continue with skill execution
- Failure → print `BinaryInstallFailedResult.manualInstructions`, then try next candidate

## 8. Chat Channel Confirmation (`channel-handler.ts`)

Slack/Discord/Telegram are message-driven and have no inline prompt capability.

### When `BinaryInstallableResult` is received

1. Store pending state in session (same structure as REST API).
2. Return a reply asking the user to confirm:
   ```
   技能 "openmeteo-sh-weather-simple" 需要安装以下工具：
     - openmeteo

   请回复 "yes" 安装，或 "no" 跳过。
   ```

### On next user message

`handleChannelMessage()` checks for pending install **before** routing:

1. If pending exists and message is `"yes"` / `"y"`:
   - Clear pending, call `execute(skill, input, { autoInstall: true })`
2. If pending exists and message is `"no"` / `"n"`:
   - Save `"never"` preference, clear pending, route normally
3. Otherwise:
   - Clear pending (stale), route normally

## 9. Failure Handling & Fallback

Per-user requirement: **detailed failure info → try next candidate → LLM fallback after 3 failures**.

```
for each candidate skill (max 3):
    result = execute(skill, input, { autoInstall: true or false depending on pref })

    if result.type === 'binary_installable':
        // In CLI: prompt user
        // In API: return install_prompt, wait for next request
        // In chat: return prompt message, wait for next message

    if result.type === 'binary_install_failed':
        // 1. Show manual instructions to user
        // 2. Continue loop → try next candidate

    if result.type === 'binary_missing':
        // No install specs — show static error
        // Continue loop → try next candidate

    if result is ExecutionResult:
        // Success — return output
        break

if loop exhausted (3 candidates, all failed):
    // Fall back to direct LLM answer
    answer = await chatClient.chat(systemPrompt, query)
    return answer
```

### `BinaryInstallFailedResult` formatting

The manual instructions are included verbatim in the response, followed by the fallback notice:

```
自动安装失败：
  openmeteo: brew install openmeteo 返回 exit code 1

你可以手动运行以下命令安装：
  brew install openmeteo

正在尝试其他技能...
```

## 10. Security Considerations

1. **Arbitrary URLs**: `download` kind fetches from URLs declared in SKILL.md. The Installer prints the URL before downloading so the user is aware of the source.
2. **No privilege escalation**: Installation commands run with the current user's permissions. The Installer never invokes `sudo`.
3. **Target directory restriction**: Default `targetDir` is `~/.local/bin` or `~/bin`. System paths (`/usr/local/bin`, `/usr/bin`) are rejected.
4. **Executable bit**: After download/extraction, `chmod +x` is applied only to the expected binary file, not the entire directory.

## 11. Example: openmeteo-sh-weather-simple

The example skill needs an `install` declaration added to its SKILL.md:

```yaml
---
name: openmeteo-sh-weather-simple
description: "Get current weather and forecasts for any city or coordinates using free OpenMeteo API."
metadata:
  openclaw:
    emoji: "🌤"
    requires:
      bins: ["openmeteo"]
    install:
      - kind: brew
        bins: ["openmeteo"]
        formula: openmeteo
        os: [darwin, linux]
      - kind: node
        bins: ["openmeteo"]
        package: openmeteo-sh
        os: [darwin, linux, win32]
homepage: https://github.com/lstpsche/openmeteo-sh
user-invocable: true
---
```

With this declaration, when a user asks "What is the weather in Berlin?":

1. Router matches `openmeteo-sh-weather-simple`
2. Executor detects `openmeteo` is missing
3. Executor finds `install` specs
4. If user preference is `"prompt"`, return `BinaryInstallableResult`
5. Caller prompts user; user replies `"yes"`
6. Executor called with `autoInstall: true`
7. Installer runs `brew install openmeteo` (on macOS/Linux) or `npm install -g openmeteo-sh` (fallback)
8. Installation succeeds; skill executes; user gets weather answer

---

## Open Questions

None — all decisions resolved during brainstorming:
- All interfaces supported (REST API, CLI, Web, chat channels)
- Mixed mode: prompt first time, remember choice (`always`/`never`/`prompt`)
- Failure handling: manual instructions → next candidate → LLM fallback after 3 failures
