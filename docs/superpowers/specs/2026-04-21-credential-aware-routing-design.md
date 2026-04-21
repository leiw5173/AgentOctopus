# Credential-Aware Routing & Structured Credential Error Design

**Date:** 2026-04-21  
**Status:** Approved  
**Problem:** The `octopus ask` command has a high failure rate because the router selects skills whose required API keys are not configured. The executor then hard-throws an untyped error, which breaks in agent contexts (OpenClaw, Hermes) and provides a poor CLI experience.

---

## Goals

1. Reduce failures by preferring skills the user can actually run (credential-aware routing)
2. When a credentialed skill is still the best match, return a structured, typed result — not an exception
3. Let each caller (CLI, REST API, agent protocol) render the error in its own appropriate way

## Non-Goals

- Silent LLM fallback when credentials are missing (user wants explicit guidance)
- Hard-excluding credentialed skills from routing (they can still win if they're the only good match)
- Interactive key-entry wizard in this iteration (future work)

---

## Architecture

Two independent layers, applied in sequence during the request flow:

```
User query
  → Router   [Layer 1: penalize skills with missing credentials]
  → Executor [Layer 2: return CredentialMissingResult instead of throwing]
  → Caller   [CLI / REST API / Agent protocol — each renders the result its own way]
```

---

## Layer 1 — Credential-Aware Routing (`packages/core/src/router.ts`)

After cosine similarity scoring produces top-K candidates, and before the LLM re-rank call, apply a credential penalty pass:

```ts
function penalizeMissingCredentials(candidates: ScoredSkill[]): ScoredSkill[] {
  return candidates.map(s => {
    const missing = getRequiredEnvVars(s.manifest).filter(v => !process.env[v.key]);
    if (missing.length === 0) return s;
    return { ...s, score: s.score - 0.25 };
  });
}
```

**Behavior:**
- Penalty of `0.25` lets a free skill beat a credentialed skill when scores are close
- Does not hard-exclude: if the credentialed skill is the only strong match, it still wins
- The penalized list is passed to the LLM re-rank step unchanged
- Uses `getRequiredEnvVars()` from `@agentoctopus/registry` — no new dependency

---

## Layer 2 — Structured Error (`packages/core/src/executor.ts`)

### New type (`packages/core/src/types.ts` or inline export)

```ts
export type CredentialMissingResult = {
  type: 'credential_missing';
  skillName: string;
  missing: RequiredEnvVar[];  // { key: string; label?: string }
};

export type ExecutionResult =
  | { type: 'success'; output: string }
  | { type: 'error'; message: string }
  | CredentialMissingResult;
```

### Executor change

Replace `throw` with `return`:

```ts
// Before:
if (missing.length > 0) {
  throw new Error(`Skill "${skill.manifest.name}" requires API keys...`);
}

// After:
if (missing.length > 0) {
  return {
    type: 'credential_missing',
    skillName: skill.manifest.name,
    missing,
  } satisfies CredentialMissingResult;
}
```

### Retry loop behavior

- `credential_missing` results do **not** trigger a retry of the same skill
- If other candidates remain, the loop continues to the next candidate
- If all candidates return `credential_missing`, the loop returns the last `CredentialMissingResult`
- Existing `error` results continue to trigger retries as before

---

## Caller-Specific Rendering

### CLI (`apps/cli/src/index.ts`)

Formatted output, no stack trace:

```
✗ x-search requires unconfigured API keys:

  • SERPAPI_KEY — Get yours at https://serpapi.com

  To configure: octopus config set SERPAPI_KEY <your-key>
```

Exits cleanly after display.

### Gateway REST API (`packages/gateway/src/engine.ts`)

Pass the structured object through as JSON response body:

```json
{
  "type": "credential_missing",
  "skillName": "x-search",
  "missing": [
    { "key": "SERPAPI_KEY", "label": "Get yours at https://serpapi.com" }
  ]
}
```

No HTTP error code change — callers inspect the `type` field.

### Agent Protocol (`packages/gateway/src/agent-protocol.ts`)

Serialize to natural-language text:

```
I matched a skill that could answer this, but it needs an API key that isn't configured:
  - SERPAPI_KEY (x-search) — Get yours at https://serpapi.com
  Run: octopus config set SERPAPI_KEY <your-key>
```

---

## Testing

### `packages/core/tests/router.test.ts`
- A skill with a missing required env var scores lower than a free skill with equal cosine similarity
- A credentialed skill that is the only candidate still gets returned (penalty doesn't exclude it)

### `packages/core/tests/executor.test.ts`
- `execute()` returns `CredentialMissingResult` (does not throw) when a required env var is absent
- Retry loop skips to the next candidate on `credential_missing`
- If all candidates are `credential_missing`, returns the last `CredentialMissingResult`

### Integration / CLI
- CLI renders the credential error with clean formatting and no stack trace
- Gateway REST response body includes `type: "credential_missing"` JSON
- Agent protocol formats the result as natural-language text

---

## Files to Change

| File | Change |
|---|---|
| `packages/core/src/types.ts` | Add `CredentialMissingResult`, update `ExecutionResult` union |
| `packages/core/src/router.ts` | Add `penalizeMissingCredentials()`, call it before LLM re-rank |
| `packages/core/src/executor.ts` | Replace `throw` with `return CredentialMissingResult`; update retry loop |
| `apps/cli/src/index.ts` | Handle `credential_missing` branch with formatted output |
| `packages/gateway/src/engine.ts` | Pass `credential_missing` result through as JSON |
| `packages/gateway/src/agent-protocol.ts` | Serialize `credential_missing` to natural-language text |
| `packages/core/tests/router.test.ts` | Add credential penalty tests |
| `packages/core/tests/executor.test.ts` | Add credential result tests |
