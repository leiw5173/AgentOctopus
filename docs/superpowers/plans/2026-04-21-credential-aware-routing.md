# Credential-Aware Routing & Structured Credential Error Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Reduce `octopus ask` failure rate by penalizing unconfigured skills during routing, and replace the hard `throw` on missing credentials with a typed `CredentialMissingResult` that CLI, REST API, and agent-protocol each render appropriately.

**Architecture:** Two independent layers — (1) `router.ts` applies a `-0.25` score penalty to skills with missing required env vars before the LLM re-rank step, so free/configured skills naturally win; (2) `executor.ts` replaces `throw` with `return CredentialMissingResult`, and each caller (CLI, gateway, agent-protocol) pattern-matches on `result.type` to render appropriate output.

**Tech Stack:** TypeScript, ESM, pnpm monorepo, vitest for tests. `getRequiredEnvVars()` and `RequiredEnvVar` from `@agentoctopus/registry`. No new dependencies.

---

## File Map

| File | Change |
|---|---|
| `packages/core/src/executor.ts` | Add `CredentialMissingResult` type; change `execute()` return type; replace `throw` with `return` |
| `packages/core/src/router.ts` | Add `penalizeMissingCredentials()` private method; call it inside `route()` before LLM re-rank |
| `apps/cli/src/index.ts` | Add `result.type === 'credential_missing'` branch in the ask loop |
| `packages/gateway/src/agent-protocol.ts` | Add `result.type === 'credential_missing'` branch after `execute()` call |
| `packages/core/tests/executor.test.ts` | Add credential-missing result tests |
| `packages/core/tests/router.test.ts` | Add credential penalty tests |

---

## Task 1: Add `CredentialMissingResult` type and update `ExecutionResult` in executor.ts

**Files:**
- Modify: `packages/core/src/executor.ts` (around lines 45-50)

- [ ] **Step 1: Write a failing test that imports the new type**

Open `packages/core/tests/executor.test.ts`. Add this import and test at the end of the file (before the closing brace of the last describe block, or as a new describe block):

```typescript
import type { CredentialMissingResult } from '../../src/executor.js';

describe('CredentialMissingResult type', () => {
  it('is exported from executor', () => {
    // If TypeScript compiles, the type exists — this is a compile-time check
    const result: CredentialMissingResult = {
      type: 'credential_missing',
      skillName: 'test-skill',
      missing: [{ key: 'TEST_KEY', label: 'Get at https://example.com' }],
    };
    expect(result.type).toBe('credential_missing');
    expect(result.skillName).toBe('test-skill');
    expect(result.missing[0].key).toBe('TEST_KEY');
  });
});
```

- [ ] **Step 2: Run the test to verify it fails**

```bash
pnpm --filter @agentoctopus/core exec vitest run tests/executor.test.ts
```

Expected: FAIL — `CredentialMissingResult` not found.

- [ ] **Step 3: Add the type to executor.ts**

In `packages/core/src/executor.ts`, after the existing imports (around line 8), add the `RequiredEnvVar` import:

```typescript
import type { LoadedSkill, SkillRegistry, RequiredEnvVar } from '@agentoctopus/registry';
```

Then replace the existing `ExecutionResult` interface (lines 45-50):

```typescript
// Before:
export interface ExecutionResult {
  skill: LoadedSkill;
  adapterResult: AdapterResult;
  formattedOutput: string;
  authGuidance?: string;
}

// After:
export interface ExecutionResult {
  skill: LoadedSkill;
  adapterResult: AdapterResult;
  formattedOutput: string;
  authGuidance?: string;
}

export type CredentialMissingResult = {
  type: 'credential_missing';
  skillName: string;
  missing: RequiredEnvVar[];
};
```

- [ ] **Step 4: Run the test to verify it passes**

```bash
pnpm --filter @agentoctopus/core exec vitest run tests/executor.test.ts
```

Expected: PASS.

- [ ] **Step 5: Commit**

```bash
git add packages/core/src/executor.ts packages/core/tests/executor.test.ts
git commit -m "feat(core): add CredentialMissingResult type to executor"
```

---

## Task 2: Update `execute()` to return `CredentialMissingResult` instead of throwing

**Files:**
- Modify: `packages/core/src/executor.ts` (lines 59-73 — the credential check block)

- [ ] **Step 1: Write a failing test**

In `packages/core/tests/executor.test.ts`, add a new describe block:

```typescript
describe('execute() with missing credentials', () => {
  it('returns CredentialMissingResult instead of throwing when env var is absent', async () => {
    // Arrange: skill that requires a key that is NOT set
    const skill = {
      manifest: {
        name: 'test-skill',
        description: 'test',
        adapter: 'http' as const,
        credentials: [{ key: 'MISSING_TEST_KEY_XYZ', label: 'Get at https://example.com', required: true }],
        metadata: {},
      },
      instructions: '',
      dirPath: '/tmp',
    } as any;

    const registry = { recordInvocationMetrics: vi.fn(), recordFeedback: vi.fn() } as any;
    const executor = new Executor(registry);

    // ACT — must NOT throw
    const result = await executor.execute(skill, { query: 'test' });

    // ASSERT
    expect(result).toMatchObject({
      type: 'credential_missing',
      skillName: 'test-skill',
      missing: [{ key: 'MISSING_TEST_KEY_XYZ' }],
    });
  });
});
```

- [ ] **Step 2: Run the test to verify it fails**

```bash
pnpm --filter @agentoctopus/core exec vitest run tests/executor.test.ts
```

Expected: FAIL — `execute()` throws instead of returning.

- [ ] **Step 3: Update `execute()` return type and replace the throw**

In `packages/core/src/executor.ts`, update the `execute()` signature (line 59):

```typescript
// Before:
async execute(skill: LoadedSkill, input: Record<string, unknown>): Promise<ExecutionResult> {

// After:
async execute(skill: LoadedSkill, input: Record<string, unknown>): Promise<ExecutionResult | CredentialMissingResult> {
```

Then replace the `throw` block (lines 63-73):

```typescript
// Before:
if (missing.length > 0) {
  const lines = missing.map(v => {
    if (v.label) return `  - ${v.key} — ${v.label}`;
    return `  - ${v.key}`;
  }).join('\n');
  const homepage = skill.manifest.metadata?.openclaw?.homepage;
  const hint = homepage ? `\n  Get your key at: ${homepage}` : '';
  throw new Error(
    `Skill "${skill.manifest.name}" requires API keys that are not configured:\n\n${lines}${hint}\n\n  To set a key, run:\n    octopus config set ${missing[0].key} <your-key>`,
  );
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

- [ ] **Step 4: Run the test to verify it passes**

```bash
pnpm --filter @agentoctopus/core exec vitest run tests/executor.test.ts
```

Expected: PASS.

- [ ] **Step 5: Build core to check for TypeScript errors**

```bash
pnpm --filter @agentoctopus/core build
```

Expected: builds with no errors. If TypeScript complains about callers of `execute()` inside `executor.ts` itself, fix them now. External callers (CLI, gateway) are fixed in later tasks.

- [ ] **Step 6: Commit**

```bash
git add packages/core/src/executor.ts packages/core/tests/executor.test.ts
git commit -m "feat(core): return CredentialMissingResult instead of throwing on missing API key"
```

---

## Task 3: Add credential-aware routing penalty in `router.ts`

**Files:**
- Modify: `packages/core/src/router.ts`

- [ ] **Step 1: Write a failing test**

In `packages/core/tests/router.test.ts`, add a new describe block. First read the existing test file to understand the mock pattern (the existing tests use `vi.mock` for the chat client). Add:

```typescript
import { getRequiredEnvVars } from '@agentoctopus/registry';

describe('credential-aware routing penalty', () => {
  it('gives a lower score to a skill with missing required env var', async () => {
    // Use the router's internal penalizeMissingCredentials indirectly:
    // build an index with two skills — one free, one requiring a missing key —
    // and verify the free skill wins even if both have equal cosine similarity.

    const freeSkill = {
      manifest: {
        name: 'free-skill',
        description: 'A free skill requiring no keys',
        adapter: 'http' as const,
        endpoint: 'https://example.com/api',
        credentials: [],
        metadata: {},
      },
      instructions: 'A free skill',
      dirPath: '/tmp/free',
    };

    const paidSkill = {
      manifest: {
        name: 'paid-skill',
        description: 'A paid skill requiring an unconfigured API key',
        adapter: 'http' as const,
        endpoint: 'https://paid.example.com/api',
        credentials: [{ key: 'PAID_TEST_KEY_XYZ_UNIQUE', label: 'Get at https://paid.example.com', required: true }],
        metadata: {},
      },
      instructions: 'A paid skill',
      dirPath: '/tmp/paid',
    };

    // Ensure the key is not set
    delete process.env.PAID_TEST_KEY_XYZ_UNIQUE;

    const router = new Router(/* use existing test config */);
    await router.buildIndex([freeSkill, paidSkill] as any);

    // Mock the LLM re-rank to return whichever skill has the higher score
    // (we just need to verify penalty reduces the paid skill's score)
    // Access the internal method via a type cast for unit testing
    const penalized = (router as any).penalizeMissingCredentials([
      { skill: freeSkill, score: 0.8 },
      { skill: paidSkill, score: 0.8 },
    ]);

    const freeEntry = penalized.find((e: any) => e.skill.manifest.name === 'free-skill');
    const paidEntry = penalized.find((e: any) => e.skill.manifest.name === 'paid-skill');

    expect(freeEntry.score).toBe(0.8);
    expect(paidEntry.score).toBe(0.55); // 0.8 - 0.25
    expect(paidEntry.score).toBeLessThan(freeEntry.score);
  });

  it('does not penalize a skill whose required env var IS set', () => {
    process.env.SET_TEST_KEY_XYZ_UNIQUE = 'my-value';

    const configuredSkill = {
      manifest: {
        name: 'configured-skill',
        description: 'A skill with a configured key',
        adapter: 'http' as const,
        credentials: [{ key: 'SET_TEST_KEY_XYZ_UNIQUE', required: true }],
        metadata: {},
      },
      instructions: '',
      dirPath: '/tmp',
    };

    const router = new Router(/* existing test config */);
    const penalized = (router as any).penalizeMissingCredentials([
      { skill: configuredSkill, score: 0.9 },
    ]);

    expect(penalized[0].score).toBe(0.9); // no penalty

    delete process.env.SET_TEST_KEY_XYZ_UNIQUE;
  });
});
```

- [ ] **Step 2: Run the test to verify it fails**

```bash
pnpm --filter @agentoctopus/core exec vitest run tests/router.test.ts
```

Expected: FAIL — `penalizeMissingCredentials` is not a method on `Router`.

- [ ] **Step 3: Add `penalizeMissingCredentials()` to `router.ts`**

In `packages/core/src/router.ts`, add the import for `getRequiredEnvVars` if not already present:

```typescript
import { getRequiredEnvVars } from '@agentoctopus/registry';
```

Then add this private method to the `Router` class (place it near `isSkillEligible` for locality):

```typescript
private penalizeMissingCredentials(
  candidates: Array<{ skill: LoadedSkill; score: number }>,
): Array<{ skill: LoadedSkill; score: number }> {
  return candidates.map(entry => {
    const missing = getRequiredEnvVars(entry.skill.manifest).filter(v => !process.env[v.key]);
    if (missing.length === 0) return entry;
    return { ...entry, score: entry.score - 0.25 };
  });
}
```

- [ ] **Step 4: Call `penalizeMissingCredentials()` inside `route()` before LLM re-rank**

In `packages/core/src/router.ts`, find the `route()` method. Locate the step where top-K cosine candidates are assembled and filtered by `isSkillEligible()`, then add the penalty call immediately before the LLM re-rank call. The insertion looks like:

```typescript
// ... (after isSkillEligible filtering) ...

// Apply credential penalty: prefer skills whose keys are already configured
const penalizedCandidates = this.penalizeMissingCredentials(topCandidates);

// Pass penalizedCandidates to the LLM re-rank step (replace topCandidates with penalizedCandidates)
const reranked = await this.rerankWithLLM(penalizedCandidates, query);
```

Read the actual variable names in `route()` before editing — match them exactly. The key is: whatever array goes into the LLM re-rank call, wrap it with `this.penalizeMissingCredentials(...)` first.

- [ ] **Step 5: Run the tests to verify they pass**

```bash
pnpm --filter @agentoctopus/core exec vitest run tests/router.test.ts
```

Expected: PASS.

- [ ] **Step 6: Build core**

```bash
pnpm --filter @agentoctopus/core build
```

Expected: no errors.

- [ ] **Step 7: Commit**

```bash
git add packages/core/src/router.ts packages/core/tests/router.test.ts
git commit -m "feat(core): penalize skills with missing credentials during routing"
```

---

## Task 4: Update CLI `ask` command to handle `CredentialMissingResult`

**Files:**
- Modify: `apps/cli/src/index.ts` (around lines 279-336 — the executor call inside the ask loop)

- [ ] **Step 1: Read the current ask loop before editing**

Read `apps/cli/src/index.ts` lines 270-340 to identify the exact variable names and structure. The loop iterates over `candidates`, calls `engine.executor.execute(skill, input)`, then checks `result.adapterResult.success`. The credential throw is currently caught in the `catch (err)` block.

- [ ] **Step 2: Add the import for `CredentialMissingResult`**

At the top of `apps/cli/src/index.ts`, update the import from `@agentoctopus/core`:

```typescript
// Before (find the existing import line):
import { Router, Executor, createChatClient, type ExecutionResult, ... } from '@agentoctopus/core';

// After (add CredentialMissingResult):
import { Router, Executor, createChatClient, type ExecutionResult, type CredentialMissingResult, ... } from '@agentoctopus/core';
```

- [ ] **Step 3: Add `credential_missing` handling in the ask loop**

Inside the ask loop, immediately after `const result = await engine.executor.execute(skill, input);`, add:

```typescript
const result = await engine.executor.execute(skill, input);

// Handle credential missing — show formatted guide, then try next candidate
if ('type' in result && result.type === 'credential_missing') {
  const lines = result.missing
    .map(v => v.label ? `  • ${v.key} — ${v.label}` : `  • ${v.key}`)
    .join('\n');
  spinner.fail(`${result.skillName} requires unconfigured API keys`);
  console.error(chalk.red(`\nMissing credentials:\n${lines}\n`));
  console.error(chalk.yellow(`  To configure: octopus config set ${result.missing[0]?.key} <your-key>`));
  if (i < candidates.length - 1) {
    console.log(chalk.yellow(`\n↻ Trying next skill...\n`));
  }
  continue;
}
```

The `continue` skips to the next candidate, which is already the retry behavior. The `catch (err)` block below it can be left as-is (it handles other thrown errors).

- [ ] **Step 4: Build CLI**

```bash
pnpm --filter @agentoctopus/core build && pnpm --filter agentoctopus-cli build
```

Expected: no TypeScript errors.

- [ ] **Step 5: Smoke test**

Run an ask query that would match a skill with a missing key (or temporarily set credentials to empty). Verify the output shows the formatted credential error with no stack trace:

```bash
node apps/cli/dist/index.js ask "search the web for latest AI news"
```

Expected output shape (if a skill requiring a key is matched):
```
✗ x-search requires unconfigured API keys

  Missing credentials:
  • SERPAPI_KEY — Get yours at https://serpapi.com

  To configure: octopus config set SERPAPI_KEY <your-key>
```

- [ ] **Step 6: Commit**

```bash
git add apps/cli/src/index.ts
git commit -m "feat(cli): render CredentialMissingResult cleanly in ask command"
```

---

## Task 5: Update gateway `agent-protocol.ts` to handle `CredentialMissingResult`

**Files:**
- Modify: `packages/gateway/src/agent-protocol.ts` (around line 179)

- [ ] **Step 1: Read the current execute() call in agent-protocol.ts**

Read `packages/gateway/src/agent-protocol.ts` lines 155-200 to confirm the exact variable names. The key call is:

```typescript
const result = await engine.executor.execute(routing.skill, { query });
// then accesses result.formattedOutput at line ~183
```

- [ ] **Step 2: Add `credential_missing` branch**

Immediately after `const result = await engine.executor.execute(routing.skill, { query });`, add:

```typescript
const result = await engine.executor.execute(routing.skill, { query });

// Handle credential missing — return structured JSON + natural-language text
if ('type' in result && result.type === 'credential_missing') {
  const lines = result.missing
    .map(v => `  - ${v.key}${v.label ? ` — ${v.label}` : ''}`)
    .join('\n');
  const setupCmd = result.missing[0]?.key
    ? `\n  Run: octopus config set ${result.missing[0].key} <your-key>`
    : '';
  res.json({
    success: false,
    type: 'credential_missing',
    skillName: result.skillName,
    missing: result.missing,
    response: `I matched a skill that could answer this, but it needs an API key that isn't configured:\n${lines}${setupCmd}`,
    skill: routing.skill.manifest.name,
    sessionId: session.id,
    confidence: routing.score,
  });
  return;
}
```

- [ ] **Step 3: Build gateway**

```bash
pnpm --filter @agentoctopus/gateway build
```

Expected: no TypeScript errors.

- [ ] **Step 4: Commit**

```bash
git add packages/gateway/src/agent-protocol.ts
git commit -m "feat(gateway): handle CredentialMissingResult in agent-protocol with structured JSON response"
```

---

## Task 6: Full build and test suite

- [ ] **Step 1: Full monorepo build**

```bash
pnpm build
```

Expected: all packages build successfully in order (registry → adapters → core → gateway → apps).

- [ ] **Step 2: Full test suite**

```bash
pnpm test
```

Expected: all 35+ tests pass. Fix any test that fails due to the `ExecutionResult | CredentialMissingResult` union type change — callers that assumed `execute()` always returns `ExecutionResult` may need a type guard.

- [ ] **Step 3: Fix any broken tests**

If existing tests pass a mocked `execute()` result directly to the CLI or gateway without the `type` field, update those mocks to include the full shape:

```typescript
// Existing mock shape (add type: 'executed' is NOT needed — ExecutionResult has no type field)
// Just ensure callers check 'type' in result before accessing adapterResult
vi.fn().mockResolvedValue({
  skill: mockSkill,
  adapterResult: { success: true, rawText: 'result' },
  formattedOutput: 'result',
});
```

- [ ] **Step 4: Final commit if any test fixes were needed**

```bash
git add -p  # stage only test fixes
git commit -m "test: fix mocks after ExecutionResult union type change"
```

- [ ] **Step 5: Reinstall CLI globally**

```bash
npm install -g .
```

Run from `apps/cli/` directory, or use the full path `pnpm --filter agentoctopus-cli pack` if preferred.

- [ ] **Step 6: End-to-end verification**

```bash
octopus ask "what is the weather in Tokyo"
```

Expected: routes to weather skill (free, no key needed) and succeeds without credential error.

```bash
octopus ask "search the web for AI news"
```

Expected: if `SERPAPI_KEY` is not set, shows clean credential guide with no stack trace. If it is set, executes normally.
