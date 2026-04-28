# Credential Guidance Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** When `octopus ask` encounters a missing API key (either pre-execution or at runtime), show an LLM-generated setup tutorial instead of a raw error.

**Architecture:** Add a pure helper `extractCredentialErrors()` to detect credential-related env var names in error text, and an Executor method `generateCredentialGuide()` that asks the configured chat LLM for a short setup tutorial. The CLI ask command rewrites both the pre-execution credential handler and the post-execution result handler to use these, with a fallback template when the LLM is unavailable.

**Tech Stack:** TypeScript, Vitest, chalk, ora

---

## File Structure

| File | Responsibility |
|------|---------------|
| `packages/core/src/executor.ts` | Add `extractCredentialErrors()` (exported standalone function) and `generateCredentialGuide()` (Executor method) |
| `packages/core/src/index.ts` | Re-export `extractCredentialErrors` |
| `apps/cli/src/index.ts` | Rewrite credential_missing handler (~line 311), add runtime credential detection (~line 337), update all-failed summary (~line 396) |
| `packages/core/tests/executor.test.ts` | Tests for `extractCredentialErrors()` and `generateCredentialGuide()` |
| `TEST_INSTRUCTIONS.md` | Manual test cases for credential guidance output |

---

### Task 1: Add `extractCredentialErrors()` with tests

**Files:**
- Modify: `packages/core/src/executor.ts` (add function before the Executor class, ~line 81)
- Modify: `packages/core/src/index.ts` (add export)
- Modify: `packages/core/tests/executor.test.ts` (add test block at end)

- [ ] **Step 1: Write failing tests for `extractCredentialErrors()`**

Add a new `describe` block at the end of `packages/core/tests/executor.test.ts`:

```typescript
describe('extractCredentialErrors', () => {
  it('extracts key from "KEY environment variable is not set"', () => {
    const result = extractCredentialErrors('Error: XAI_API_KEY environment variable is not set.');
    expect(result).toEqual(['XAI_API_KEY']);
  });

  it('extracts key from "KEY is not set"', () => {
    const result = extractCredentialErrors('SERPER_API_KEY is not set');
    expect(result).toEqual(['SERPER_API_KEY']);
  });

  it('extracts key from "requires KEY"', () => {
    const result = extractCredentialErrors('--news requires SERPER_API_KEY');
    expect(result).toEqual(['SERPER_API_KEY']);
  });

  it('extracts multiple keys from comma-separated list', () => {
    const result = extractCredentialErrors(
      '--news requires SERPER_API_KEY, TAVILY_API_KEY, SERPAPI_API_KEY, YOU_API_KEY, or SEARXNG_INSTANCE_URL'
    );
    expect(result).toEqual(['SERPER_API_KEY', 'TAVILY_API_KEY', 'SERPAPI_API_KEY', 'YOU_API_KEY', 'SEARXNG_INSTANCE_URL']);
  });

  it('extracts key from "missing KEY"', () => {
    const result = extractCredentialErrors('Error: missing OPENAI_API_KEY');
    expect(result).toEqual(['OPENAI_API_KEY']);
  });

  it('extracts key from "needs KEY"', () => {
    const result = extractCredentialErrors('This skill needs GITHUB_TOKEN to work');
    expect(result).toEqual(['GITHUB_TOKEN']);
  });

  it('extracts key with _URL suffix', () => {
    const result = extractCredentialErrors('requires SEARXNG_INSTANCE_URL');
    expect(result).toEqual(['SEARXNG_INSTANCE_URL']);
  });

  it('extracts key with _SECRET suffix', () => {
    const result = extractCredentialErrors('AWS_SECRET_KEY is not set');
    expect(result).toEqual(['AWS_SECRET_KEY']);
  });

  it('returns empty array when no credential pattern matches', () => {
    const result = extractCredentialErrors('Connection timeout after 30s');
    expect(result).toEqual([]);
  });

  it('deduplicates keys mentioned multiple times', () => {
    const result = extractCredentialErrors('XAI_API_KEY is not set. Please set XAI_API_KEY.');
    expect(result).toEqual(['XAI_API_KEY']);
  });

  it('extracts from JSON error output', () => {
    const json = JSON.stringify({ report: 'Search failed: Error: XAI_API_KEY environment variable is not set.\n', status: 'error' });
    const result = extractCredentialErrors(json);
    expect(result).toEqual(['XAI_API_KEY']);
  });

  it('only scans first 2000 chars', () => {
    const padding = 'x'.repeat(2100);
    const result = extractCredentialErrors(padding + 'XAI_API_KEY is not set');
    expect(result).toEqual([]);
  });
});
```

Add the import at the top of the test file (line 2, after the Executor import):

```typescript
import { extractCredentialErrors } from '../src/executor.js';
```

- [ ] **Step 2: Run tests to verify they fail**

Run: `pnpm --filter @agentoctopus/core exec vitest run tests/executor.test.ts`
Expected: FAIL — `extractCredentialErrors` is not exported from executor.ts

- [ ] **Step 3: Implement `extractCredentialErrors()`**

Add this function to `packages/core/src/executor.ts`, just before the `export class Executor` line (~line 100):

```typescript
/**
 * Scan error text for env-var names that look like missing credentials.
 * Only scans the first 2000 characters to avoid processing huge outputs.
 */
export function extractCredentialErrors(text: string): string[] {
  const scan = text.slice(0, 2000);
  const keyPattern = /[A-Z][A-Z0-9_]*(?:API_KEY|_KEY|_TOKEN|_SECRET|_URL)/g;

  const triggers = [
    /([A-Z][A-Z0-9_]*(?:API_KEY|_KEY|_TOKEN|_SECRET|_URL))\s+(?:environment\s+variable\s+)?is\s+not\s+set/gi,
    /(?:requires?|needs?|missing)\s+([A-Z][A-Z0-9_]*(?:API_KEY|_KEY|_TOKEN|_SECRET|_URL))/gi,
  ];

  const found = new Set<string>();

  for (const re of triggers) {
    let m: RegExpExecArray | null;
    while ((m = re.exec(scan)) !== null) {
      found.add(m[1]!);
    }
  }

  // Handle comma-separated lists: "requires KEY1, KEY2, KEY3, or KEY4"
  // If we matched at least one key from a "requires" pattern, scan the surrounding
  // text for additional KEY_PATTERN matches in the same sentence.
  if (found.size > 0) {
    const sentencePattern = /(?:requires?|needs?|missing)\s+[^.;\n]{0,300}/gi;
    let sm: RegExpExecArray | null;
    while ((sm = sentencePattern.exec(scan)) !== null) {
      const sentence = sm[0];
      let km: RegExpExecArray | null;
      while ((km = keyPattern.exec(sentence)) !== null) {
        found.add(km[0]);
      }
    }
  }

  return [...found];
}
```

- [ ] **Step 4: Add the export to `packages/core/src/index.ts`**

Add `extractCredentialErrors` to the executor export line:

```typescript
export { Executor, extractCredentialErrors, type ExecutionResult, type CredentialMissingResult, type BinaryMissingResult } from './executor.js';
```

- [ ] **Step 5: Build and run tests to verify they pass**

Run: `pnpm --filter @agentoctopus/core build && pnpm --filter @agentoctopus/core exec vitest run tests/executor.test.ts`
Expected: All `extractCredentialErrors` tests PASS

- [ ] **Step 6: Commit**

```bash
git add packages/core/src/executor.ts packages/core/src/index.ts packages/core/tests/executor.test.ts
git commit -m "feat(core): add extractCredentialErrors() for detecting missing API keys in error text

Scans error messages and output for patterns like 'KEY is not set',
'requires KEY', 'missing KEY' — including comma-separated lists.
Only scans first 2000 chars to avoid processing huge outputs.

Co-Authored-By: Claude Opus 4.6 <noreply@anthropic.com>"
```

---

### Task 2: Add `generateCredentialGuide()` to Executor

**Files:**
- Modify: `packages/core/src/executor.ts` (add method to Executor class, after `execute()`)
- Modify: `packages/core/tests/executor.test.ts` (add test block)

- [ ] **Step 1: Write failing tests for `generateCredentialGuide()`**

Add to `packages/core/tests/executor.test.ts`:

```typescript
describe('Executor.generateCredentialGuide()', () => {
  it('returns LLM-generated guide when chatClient is available', async () => {
    const mockChat = vi.fn().mockResolvedValue(
      'XAI_API_KEY — xAI Grok API key\n1. Sign up at https://console.x.ai/\n2. Create an API key\n3. Run: octopus config set XAI_API_KEY <your-key>'
    );
    const registry = { recordInvocationMetrics: vi.fn(), readInstructions: vi.fn().mockReturnValue('') } as any;
    const executor = new Executor(registry, { chat: mockChat } as any);

    const guide = await executor.generateCredentialGuide('x-search', 'Search X posts', ['XAI_API_KEY']);

    expect(guide).toContain('XAI_API_KEY');
    expect(guide).toContain('octopus config set');
    expect(mockChat).toHaveBeenCalledOnce();
    expect(mockChat.mock.calls[0][1]).toContain('x-search');
    expect(mockChat.mock.calls[0][1]).toContain('XAI_API_KEY');
  });

  it('returns fallback template when chatClient is not available', async () => {
    const registry = { recordInvocationMetrics: vi.fn(), readInstructions: vi.fn().mockReturnValue('') } as any;
    const executor = new Executor(registry); // no chatClient

    const guide = await executor.generateCredentialGuide('x-search', 'Search X posts', ['XAI_API_KEY']);

    expect(guide).toContain('XAI_API_KEY');
    expect(guide).toContain('octopus config set XAI_API_KEY');
  });

  it('returns fallback template when LLM call throws', async () => {
    const mockChat = vi.fn().mockRejectedValue(new Error('network error'));
    const registry = { recordInvocationMetrics: vi.fn(), readInstructions: vi.fn().mockReturnValue('') } as any;
    const executor = new Executor(registry, { chat: mockChat } as any);

    const guide = await executor.generateCredentialGuide('x-search', 'Search X posts', ['XAI_API_KEY']);

    expect(guide).toContain('XAI_API_KEY');
    expect(guide).toContain('octopus config set XAI_API_KEY');
  });

  it('handles multiple missing keys in fallback', async () => {
    const registry = { recordInvocationMetrics: vi.fn(), readInstructions: vi.fn().mockReturnValue('') } as any;
    const executor = new Executor(registry);

    const guide = await executor.generateCredentialGuide('web-search-pro', 'Web search', ['SERPER_API_KEY', 'TAVILY_API_KEY']);

    expect(guide).toContain('SERPER_API_KEY');
    expect(guide).toContain('TAVILY_API_KEY');
    expect(guide).toContain('octopus config set SERPER_API_KEY');
    expect(guide).toContain('octopus config set TAVILY_API_KEY');
  });
});
```

- [ ] **Step 2: Run tests to verify they fail**

Run: `pnpm --filter @agentoctopus/core exec vitest run tests/executor.test.ts`
Expected: FAIL — `generateCredentialGuide` is not a method on Executor

- [ ] **Step 3: Implement `generateCredentialGuide()`**

Add this method to the `Executor` class in `packages/core/src/executor.ts`, right after the `execute()` method (after line 219):

```typescript
  async generateCredentialGuide(
    skillName: string,
    skillDescription: string,
    missingKeys: string[],
  ): Promise<string> {
    const keyList = missingKeys.join(', ');
    const fallback = missingKeys
      .map(k => `${k} is required but not configured.\n  Run: octopus config set ${k} <your-key>`)
      .join('\n\n');

    if (!this.chatClient) return fallback;

    const prompt = `The CLI tool "octopus" tried to run the skill "${skillName}" (${skillDescription}) but it failed because the following API key(s) are not configured: ${keyList}.

For each missing key, provide a SHORT setup guide with:
1. What provider/service the key is for (one line)
2. The sign-up or API key page URL
3. The command: octopus config set KEY_NAME <your-key>

Keep it concise — 3 lines per key max. No markdown headers.
If you're not confident about the URL, say "Visit the provider's website" instead.`;

    try {
      const guide = await Promise.race([
        this.chatClient.chat('You are a helpful assistant that provides concise API key setup instructions.', prompt),
        new Promise<never>((_, reject) => setTimeout(() => reject(new Error('timeout')), 10_000)),
      ]);
      return guide.trim() || fallback;
    } catch {
      return fallback;
    }
  }
```

- [ ] **Step 4: Build and run tests to verify they pass**

Run: `pnpm --filter @agentoctopus/core build && pnpm --filter @agentoctopus/core exec vitest run tests/executor.test.ts`
Expected: All `generateCredentialGuide` tests PASS

- [ ] **Step 5: Commit**

```bash
git add packages/core/src/executor.ts packages/core/tests/executor.test.ts
git commit -m "feat(core): add Executor.generateCredentialGuide() for LLM-powered setup tutorials

Asks the configured chat LLM to generate a short setup guide when a
skill fails due to missing API keys. Falls back to a simple template
when the LLM is unavailable or times out (10s).

Co-Authored-By: Claude Opus 4.6 <noreply@anthropic.com>"
```

---

### Task 3: Rewrite CLI pre-execution credential handler

**Files:**
- Modify: `apps/cli/src/index.ts` (~lines 311-321)

- [ ] **Step 1: Add import for `extractCredentialErrors`**

In `apps/cli/src/index.ts`, update the import from `@agentoctopus/core` (line 11) to include `extractCredentialErrors`:

```typescript
import { Router, Executor, createChatClient, dbg, type LLMConfig, type CredentialMissingResult, extractCredentialErrors } from '@agentoctopus/core';
```

- [ ] **Step 2: Rewrite the `credential_missing` handler**

Replace lines 311-321 in `apps/cli/src/index.ts`:

Old code:
```typescript
        if ('type' in result && result.type === 'credential_missing') {
          const lines = result.missing
            .map((v: { key: string; label?: string }) => v.label ? `  • ${v.key} — ${v.label}` : `  • ${v.key}`)
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

New code:
```typescript
        if ('type' in result && result.type === 'credential_missing') {
          spinner.fail(`${result.skillName} requires unconfigured API keys`);
          const guideSpinner = ora('Generating setup guide...').start();
          const missingKeys = result.missing.map(v => v.key);
          const guide = await engine.executor.generateCredentialGuide(
            result.skillName,
            skill.manifest.description,
            missingKeys,
          );
          guideSpinner.stop();
          console.log();
          console.log(chalk.yellow(guide.split('\n').map(l => `  ${l}`).join('\n')));
          console.log();
          failedResults.push({ authGuidance: undefined, credentialError: true });
          if (i < candidates.length - 1) {
            console.log(chalk.yellow(`↻ Trying next skill...\n`));
          }
          continue;
        }
```

- [ ] **Step 3: Update the `failedResults` type**

Replace line 285:

Old:
```typescript
    const failedResults: Array<{ authGuidance?: string }> = [];
```

New:
```typescript
    const failedResults: Array<{ authGuidance?: string; credentialError?: boolean }> = [];
```

- [ ] **Step 4: Update the existing `failedResults.push` in the execution failure block**

At line 382, update the push to include the new field:

Old:
```typescript
        failedResults.push({ authGuidance: execResult.authGuidance });
```

New:
```typescript
        failedResults.push({ authGuidance: execResult.authGuidance, credentialError: false });
```

- [ ] **Step 5: Build to verify no type errors**

Run: `pnpm --filter @agentoctopus/core build && pnpm --filter @agentoctopus/cli build`
Expected: Build succeeds with no errors

- [ ] **Step 6: Commit**

```bash
git add apps/cli/src/index.ts
git commit -m "feat(cli): show LLM-generated setup guide for pre-execution credential errors

Replaces the bare 'octopus config set KEY' message with an
LLM-generated tutorial showing what the key is, where to get it,
and the config command to set it.

Co-Authored-By: Claude Opus 4.6 <noreply@anthropic.com>"
```

---

### Task 4: Add runtime credential error detection in CLI

**Files:**
- Modify: `apps/cli/src/index.ts` (~lines 337-363, the `adapterResult.success` block)

- [ ] **Step 1: Add runtime credential detection after successful execution**

Replace the success block (lines 337-363) with credential-aware logic. The existing code is:

```typescript
        if (execResult.adapterResult.success) {
          succeeded = true;
          const totalSec = ((t3 - t0) / 1000).toFixed(1);
          spinner.succeed(`Execution successful (${totalSec}s)\n`);
          console.log(chalk.green('Result:'));
          console.log(execResult.formattedOutput + '\n');

          // Ask for feedback
          if (options.prompt !== false) {
            // ... feedback rl code ...
          }
          break;
        }
```

Replace with:

```typescript
        if (execResult.adapterResult.success) {
          // Check if "successful" output actually contains a credential error
          const outputText = execResult.formattedOutput + '\n' + (execResult.adapterResult.rawText ?? '');
          const runtimeCredKeys = extractCredentialErrors(outputText);

          // Also check for JSON with "status": "error" containing credential errors
          if (runtimeCredKeys.length === 0 && execResult.adapterResult.rawText) {
            try {
              const parsed = JSON.parse(execResult.adapterResult.rawText.trim());
              if (parsed.status === 'error') {
                const errorText = String(parsed.report ?? parsed.error ?? parsed.message ?? '');
                runtimeCredKeys.push(...extractCredentialErrors(errorText));
              }
            } catch {
              // not JSON, already scanned above
            }
          }

          if (runtimeCredKeys.length > 0) {
            spinner.fail(`${skill.manifest.name} failed: missing API key\n`);
            const guideSpinner = ora('Generating setup guide...').start();
            const guide = await engine.executor.generateCredentialGuide(
              skill.manifest.name,
              skill.manifest.description,
              runtimeCredKeys,
            );
            guideSpinner.stop();
            console.log(chalk.yellow(guide.split('\n').map(l => `  ${l}`).join('\n')));
            console.log();
            failedResults.push({ authGuidance: undefined, credentialError: true });
            if (i < candidates.length - 1) {
              console.log(chalk.yellow(`↻ Trying next skill...\n`));
            }
            continue;
          }

          succeeded = true;
          const totalSec = ((t3 - t0) / 1000).toFixed(1);
          spinner.succeed(`Execution successful (${totalSec}s)\n`);
          console.log(chalk.green('Result:'));
          console.log(execResult.formattedOutput + '\n');

          // Ask for feedback
          if (options.prompt !== false) {
            const rl = readline.createInterface({
              input: process.stdin,
              output: process.stdout,
            });

            rl.question(chalk.yellow('Was this helpful? (y/n): '), (answer) => {
              const isPositive = answer.toLowerCase() === 'y' || answer.toLowerCase() === 'yes';

              rl.question(chalk.yellow('Any comments? (press Enter to skip): '), (comment) => {
                const trimmed = comment.trim() || undefined;
                engine.registry.recordFeedback(skill.manifest.name, isPositive, trimmed, 'cli');
                console.log(chalk.gray('Thank you for your feedback! Rating updated.'));
                rl.close();
              });
            });
          }
          break;
        }
```

Note: `runtimeCredKeys` needs to be declared with `let` since we may push into it from the JSON check. Update the first declaration:

```typescript
          let runtimeCredKeys = extractCredentialErrors(outputText);
```

- [ ] **Step 2: Build to verify no type errors**

Run: `pnpm --filter @agentoctopus/cli build`
Expected: Build succeeds

- [ ] **Step 3: Commit**

```bash
git add apps/cli/src/index.ts
git commit -m "feat(cli): detect credential errors in runtime output and show setup guide

When a skill executes 'successfully' but its output contains a
credential error (like 'XAI_API_KEY is not set'), detect it and show
an LLM-generated setup tutorial instead of the raw error JSON.

Co-Authored-By: Claude Opus 4.6 <noreply@anthropic.com>"
```

---

### Task 5: Update all-failed summary to track credential failures

**Files:**
- Modify: `apps/cli/src/index.ts` (~lines 396-402)

- [ ] **Step 1: Update the all-failed summary block**

Replace lines 396-402:

Old:
```typescript
    if (!succeeded && candidates.length > 0) {
      const authGuidance = failedResults.find(r => r.authGuidance)?.authGuidance;
      if (authGuidance) {
        console.log('\n' + authGuidance);
      }
      // All skill retries failed — fall back to a direct LLM answer
      console.log(chalk.yellow(`\nAll ${candidates.length} skill(s) failed. Answering directly...\n`));
```

New:
```typescript
    if (!succeeded && candidates.length > 0) {
      const authGuidance = failedResults.find(r => r.authGuidance)?.authGuidance;
      if (authGuidance) {
        console.log('\n' + authGuidance);
      }
      const allCredential = failedResults.length > 0 && failedResults.every(r => r.credentialError);
      const msg = allCredential
        ? `All ${candidates.length} skill(s) failed due to missing API keys. Answering directly...`
        : `All ${candidates.length} skill(s) failed. Answering directly...`;
      console.log(chalk.yellow(`\n${msg}\n`));
```

- [ ] **Step 2: Build to verify**

Run: `pnpm --filter @agentoctopus/cli build`
Expected: Build succeeds

- [ ] **Step 3: Commit**

```bash
git add apps/cli/src/index.ts
git commit -m "feat(cli): distinguish credential failures in all-failed summary

When all skill attempts failed due to missing API keys, the summary
now says 'failed due to missing API keys' instead of the generic
'failed' message.

Co-Authored-By: Claude Opus 4.6 <noreply@anthropic.com>"
```

---

### Task 6: Update TEST_INSTRUCTIONS.md

**Files:**
- Modify: `TEST_INSTRUCTIONS.md`

- [ ] **Step 1: Add manual test cases for credential guidance**

Add the following after section 9.7 in `TEST_INSTRUCTIONS.md`:

```markdown
### 9.8 Credential guidance — pre-execution (missing declared key)

```bash
# Ensure XAI_API_KEY is NOT set, then ask a query that routes to x-search
unset XAI_API_KEY
node apps/cli/dist/index.js ask "search X for latest AI news"
```

**Expected:**
- Spinner shows "Generating setup guide..."
- Output includes the key name (e.g. `XAI_API_KEY`), a provider description, and `octopus config set XAI_API_KEY <your-key>`
- Does NOT show raw "Missing credentials" with bare bullet points

### 9.9 Credential guidance — runtime error (key not in SKILL.md requires)

```bash
# Ask a query that routes to a skill whose script fails due to missing env var
node apps/cli/dist/index.js ask "search the latest AI news"
```

**Expected:**
- If the skill's output contains `"status": "error"` with a key pattern, shows "failed: missing API key" (NOT "Execution successful")
- Shows LLM-generated setup guide with provider info and `octopus config set` command

### 9.10 Credential guidance — LLM fallback

```bash
# Temporarily break LLM config to test fallback
# (e.g. set an invalid API key for the LLM provider)
node apps/cli/dist/index.js ask "search X for AI news"
```

**Expected:**
- When LLM guide generation fails, falls back to simple template:
  `KEY_NAME is required but not configured.`
  `Run: octopus config set KEY_NAME <your-key>`
```

Also add these rows to the checklist table in the same section:

```markdown
| 9.8 | Credential guidance shows LLM-generated setup tutorial (pre-execution) | ☐ |
| 9.9 | Runtime credential error detected and shown with setup guide | ☐ |
| 9.10 | Credential guidance falls back to template when LLM unavailable | ☐ |
```

- [ ] **Step 2: Commit**

```bash
git add TEST_INSTRUCTIONS.md
git commit -m "docs: add manual test cases for credential guidance output

Co-Authored-By: Claude Opus 4.6 <noreply@anthropic.com>"
```

---

### Task 7: Full build and test verification

**Files:** None (verification only)

- [ ] **Step 1: Run full build**

Run: `pnpm build`
Expected: All packages build successfully

- [ ] **Step 2: Run all tests**

Run: `pnpm test`
Expected: All tests pass (existing + new extractCredentialErrors + generateCredentialGuide tests)

- [ ] **Step 3: Manual smoke test**

Run: `node apps/cli/dist/index.js ask "search the latest AI news"`

Expected: If a credential error occurs, the output shows a setup guide instead of a raw error. Verify:
1. Spinner shows "Generating setup guide..."
2. Guide includes key name, provider description, and `octopus config set` command
3. If all skills fail due to credentials, summary says "failed due to missing API keys"
