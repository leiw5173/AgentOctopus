# Credential Guidance for `octopus ask` — Design Spec

**Date:** 2026-04-28
**Branch:** feat/skill-invocation-rebuild
**Status:** Approved

## Problem

When `octopus ask` selects a skill that requires an API key the user hasn't configured, the CLI output is confusing and unhelpful:

1. **Pre-execution check catches it:** Shows "Missing credentials" with a bare `octopus config set KEY <your-key>` line — no explanation of what the key is or where to get it.
2. **Runtime error (more common):** The skill runs, fails internally, and the CLI shows either a raw error string (`Error: XAI_API_KEY environment variable is not set`) or marks execution as "successful" but prints error JSON. No setup guidance at all.

Users need to know: what key is missing, what it's for, where to get it, and how to configure it.

## Solution: LLM-Powered Credential Error Guidance

Use the already-configured chat LLM to generate a short setup tutorial when a credential error is detected. No schema changes required — the LLM infers provider info from the key name and skill description.

## Detection

### Path 1: Pre-execution credential check (existing)

`Executor.execute()` already returns `CredentialMissingResult` when declared required env vars are missing. No detection changes needed — just improve the CLI output when this result type is returned.

### Path 2: Runtime credential error detection (new)

After a skill executes, if the result indicates failure OR the output contains error indicators, scan the error message and formatted output for credential patterns.

**New helper: `extractCredentialErrors(text: string): string[]`**

Located in `packages/core/src/executor.ts`. Returns an array of env-var names that appear to be missing based on the error text.

Regex patterns to match:
- `KEY_NAME environment variable is not set`
- `KEY_NAME is not set`
- `requires KEY_NAME`
- `needs KEY_NAME`
- `missing KEY_NAME`

Where `KEY_NAME` matches `/[A-Z][A-Z0-9_]*(?:API_KEY|_KEY|_TOKEN|_SECRET|_URL)/` (includes `_URL` to catch config values like `SEARXNG_INSTANCE_URL`).

Also handles comma-separated lists: `"requires SERPER_API_KEY, TAVILY_API_KEY, or SEARXNG_INSTANCE_URL"`.

For results where `adapterResult.success` is `true` but the formatted output looks like an error (contains `"status":"error"` or `"status": "error"` when parsed as JSON), treat this as a runtime failure. Extract the `report`, `error`, or `message` field from the JSON and apply the same credential patterns.

## LLM Setup Guide Generation

### New method: `Executor.generateCredentialGuide()`

```typescript
async generateCredentialGuide(
  skillName: string,
  skillDescription: string,
  missingKeys: string[]
): Promise<string>
```

**Prompt:**
```
The CLI tool "octopus" tried to run the skill "{skillName}" ({skillDescription})
but it failed because the following API key(s) are not configured: {missingKeys}.

For each missing key, provide a SHORT setup guide with:
1. What provider/service the key is for (one line)
2. The sign-up or API key page URL
3. The command: octopus config set KEY_NAME <your-key>

Keep it concise — 3 lines per key max. No markdown headers.
If you're not confident about the URL, say "Visit the provider's website" instead.
```

**Behavior:**
- Uses the existing `chatClient` from the executor (no extra config)
- Timeout: 10 seconds
- On LLM failure (network, timeout, no chatClient), falls back to a simple template:
  ```
  {KEY_NAME} is required but not configured.
  Run: octopus config set {KEY_NAME} <your-key>
  ```

## CLI Output Changes

### Pre-execution credential miss (apps/cli/src/index.ts ~lines 311-321)

Before:
```
✖ x-search requires unconfigured API keys

Missing credentials:
  • XAI_API_KEY

  To configure: octopus config set XAI_API_KEY <your-key>
```

After:
```
✖ x-search requires unconfigured API keys

  XAI_API_KEY — xAI Grok API key for searching X/Twitter
  1. Sign up at https://console.x.ai/
  2. Create an API key
  3. Run: octopus config set XAI_API_KEY <your-key>
```

A spinner ("Generating setup guide...") shows during the LLM call.

### Runtime credential error (apps/cli/src/index.ts ~lines 337-382)

Before:
```
✔ Execution successful (17.2s)

Result:
{"report":"Search failed: Error: XAI_API_KEY environment variable is not set.\n","status":"error"}
```

After:
```
✖ x-search failed: missing API key

  XAI_API_KEY — xAI Grok API key for searching X/Twitter
  1. Sign up at https://console.x.ai/
  2. Create an API key
  3. Run: octopus config set XAI_API_KEY <your-key>
```

The detection logic runs after execution completes:
1. Check if `adapterResult.success` is false, or if the formatted output contains `"status": "error"` or similar error indicators
2. Run `extractCredentialErrors()` against the error message and/or formatted output
3. If credential keys are found, call `generateCredentialGuide()` and show the tutorial instead of the raw error
4. If no credential keys are found, fall through to the existing error display logic

### All-skills-failed summary (apps/cli/src/index.ts ~lines 396-402)

Track whether any failures were credential-related. If all failures were credential errors:
```
All 2 skill(s) failed due to missing API keys. Answering directly...
```

Otherwise keep existing behavior:
```
All 2 skill(s) failed. Answering directly...
```

## File Changes

| File | Change |
|------|--------|
| `packages/core/src/executor.ts` | Add `extractCredentialErrors()` helper function, add `generateCredentialGuide()` method to Executor class |
| `packages/core/src/index.ts` | Export `extractCredentialErrors` |
| `apps/cli/src/index.ts` | Rewrite `credential_missing` handler to show LLM guide; add runtime credential detection in the execution result handling; update all-failed summary |
| `packages/core/tests/executor.test.ts` | Tests for `extractCredentialErrors()` patterns, `generateCredentialGuide()` with mock LLM and fallback |
| `TEST_INSTRUCTIONS.md` | Add manual test cases for credential guidance output |

## Edge Cases

- **Multiple missing keys:** Show guidance for all keys, not just the first
- **LLM unavailable:** Fall back to template with `octopus config set` command
- **Key pattern not recognized:** Fall through to existing raw error display
- **Skill output is large:** Only scan first 2000 chars for credential patterns
- **Optional keys (web-search-pro):** These won't trigger the pre-execution check since they're marked optional in metadata. Runtime detection handles them when the skill fails because none of its optional providers are configured.

## Non-Goals

- No changes to the `RequiredEnvVar` type or `CredentialSchema`
- No changes to SKILL.md format or metadata schema
- No caching of LLM-generated guides (each invocation generates fresh)
- No changes to the web app or agent-protocol error handling (CLI only)
