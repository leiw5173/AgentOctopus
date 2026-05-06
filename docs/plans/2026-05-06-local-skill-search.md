# Local Skill Search Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Replace the remote ClawHub `octopus search` command with a local scored skill search, extracting shared scoring utilities from the router.

**Architecture:** Extract `extractQueryTokens` and `scoreKeywordMatch` from `router.ts` into a new `@agentoctopus/skills` module (`search.ts`). Enhance `registry.search()` to use scored token matching. Replace the CLI `search` command to call `registry.search()` with an optional `--run` interactive pick-and-run mode.

**Tech Stack:** TypeScript, Vitest, Commander.js, Chalk, Ora

---

## Task 1: Create shared scoring utility in `@agentoctopus/skills`

**Files:**

- Create: `packages/skills/src/search.ts`
- Modify: `packages/skills/src/index.ts`

- [ ] **Step 1: Write the scoring utility**

```typescript
// packages/skills/src/search.ts

/** CJK character range (Chinese, Japanese, Korean) */
export const CJK_RANGE = /[　-鿿가-힯豈-﫿]/;

/**
 * Extract meaningful query tokens. For Latin text, splits on word boundaries
 * and filters short words (3+ chars). For CJK text, keeps individual characters.
 */
export function extractQueryTokens(query: string): string[] {
  const lower = query.toLowerCase();
  const tokens: string[] = [];
  const latinWords = lower.match(/[a-z]{3,}/g) ?? [];
  tokens.push(...latinWords);
  const cjkChars = lower.match(/[　-鿿가-힯豈-﫿]/g) ?? [];
  tokens.push(...cjkChars);
  return [...new Set(tokens)];
}

/** Minimal interface for scoring — avoids circular dependency on @agentoctopus/registry */
export interface SearchableSkill {
  name: string;
  description: string;
  tags: string[];
}

/**
 * Score how well a skill matches query tokens. Uses word-boundary-start
 * prefix matching for Latin words — token must start at a word boundary but
 * can be a prefix of a longer word. For CJK characters, checks direct inclusion.
 *
 * Scoring: +2 for name match, +1 for description/tag match per token.
 */
export function scoreKeywordMatch(tokens: string[], skill: SearchableSkill): number {
  const name = skill.name.toLowerCase();
  const desc = skill.description.toLowerCase();
  const tags = skill.tags.join(' ').toLowerCase();

  let score = 0;
  for (const token of tokens) {
    if (CJK_RANGE.test(token)) {
      if (name.includes(token)) score += 2;
      else if (desc.includes(token)) score += 1;
      else if (tags.includes(token)) score += 1;
    } else {
      const pattern = new RegExp(`\\b${token}`, 'i');
      if (pattern.test(name)) score += 2;
      else if (pattern.test(desc)) score += 1;
      else if (pattern.test(tags)) score += 1;
    }
  }
  return score;
}
```

- [ ] **Step 2: Add re-exports in index.ts**

Read `packages/skills/src/index.ts` (currently a placeholder comment). Replace with:

```typescript
export { extractQueryTokens, scoreKeywordMatch, CJK_RANGE, type SearchableSkill } from './search.js';
```

- [ ] **Step 3: Build the skills package**

```bash
pnpm --filter @agentoctopus/skills build
```

- [ ] **Step 4: Commit**

```bash
git add packages/skills/src/search.ts packages/skills/src/index.ts
git commit -m "feat(skills): add shared search scoring utility (extractQueryTokens, scoreKeywordMatch)"
```

---

## Task 2: Write tests for the scoring utility

**Files:**

- Create: `packages/skills/tests/search.test.ts`

- [ ] **Step 1: Write the test file**

```typescript
import { describe, it, expect } from 'vitest';
import { extractQueryTokens, scoreKeywordMatch, type SearchableSkill } from '../src/search.js';

describe('extractQueryTokens', () => {
  it('extracts Latin words of 3+ characters', () => {
    const tokens = extractQueryTokens('weather forecast today');
    expect(tokens).toEqual(['weather', 'forecast', 'today']);
  });

  it('filters out short words (1-2 chars)', () => {
    const tokens = extractQueryTokens('is it sunny in to');
    expect(tokens).toEqual(['sunny']);
  });

  it('extracts CJK characters', () => {
    const tokens = extractQueryTokens('天気 予報');
    expect(tokens).toContain('天');
    expect(tokens).toContain('気');
  });

  it('deduplicates tokens', () => {
    const tokens = extractQueryTokens('weather weather WEATHER');
    expect(tokens).toEqual(['weather']);
  });

  it('handles mixed Latin and CJK', () => {
    const tokens = extractQueryTokens('東京 weather');
    expect(tokens).toContain('weather');
    expect(tokens).toContain('東');
    expect(tokens).toContain('京');
  });
});

describe('scoreKeywordMatch', () => {
  const skill: SearchableSkill = {
    name: 'weather-forecast',
    description: 'Get weather forecasts and current conditions',
    tags: ['weather', 'api', 'forecast'],
  };

  it('scores exact name prefix match highest', () => {
    const tokens = extractQueryTokens('weather');
    const score = scoreKeywordMatch(tokens, skill);
    expect(score).toBe(2); // name match
  });

  it('scores partial name prefix match', () => {
    const tokens = extractQueryTokens('forecast');
    const score = scoreKeywordMatch(tokens, skill);
    expect(score).toBe(2); // "forecast" matches word boundary start of "weather-forecast"
  });

  it('scores description match lower', () => {
    const tokens = extractQueryTokens('conditions');
    const score = scoreKeywordMatch(tokens, skill);
    expect(score).toBe(1); // in description only
  });

  it('scores tag match lower', () => {
    const tokens = extractQueryTokens('api');
    const score = scoreKeywordMatch(tokens, skill);
    expect(score).toBe(1); // in tags only
  });

  it('scores multiple tokens cumulatively', () => {
    const tokens = extractQueryTokens('weather conditions');
    const score = scoreKeywordMatch(tokens, skill);
    expect(score).toBe(3); // name (2) + description (1)
  });

  it('returns 0 for no match', () => {
    const tokens = extractQueryTokens('xyzzy nothing');
    const score = scoreKeywordMatch(tokens, skill);
    expect(score).toBe(0);
  });

  it('handles CJK token matching', () => {
    const cjkSkill: SearchableSkill = {
      name: '天気予報',
      description: '天気予報を取得します',
      tags: ['天気'],
    };
    const tokens = extractQueryTokens('天気');
    const score = scoreKeywordMatch(tokens, cjkSkill);
    expect(score).toBe(2); // name includes 天気
  });
});
```

- [ ] **Step 2: Run the tests**

```bash
pnpm --filter @agentoctopus/skills exec vitest run tests/search.test.ts
```

Expected: all 10 tests pass.

- [ ] **Step 3: Commit**

```bash
git add packages/skills/tests/search.test.ts
git commit -m "test(skills): add tests for search scoring utility"
```

---

## Task 3: Enhance `registry.search()` with scored matching

**Files:**

- Modify: `packages/registry/src/registry.ts:190-198`

- [ ] **Step 1: Update the import and replace the search method**

In `packages/registry/src/registry.ts`, add the import at the top (after existing imports):

```typescript
import { extractQueryTokens, scoreKeywordMatch } from '@agentoctopus/skills';
```

Replace the existing `search()` method (lines 190-198):

```typescript
// old:
  search(query: string): LoadedSkill[] {
    const q = query.toLowerCase();
    return this.getAll().filter(
      (s) =>
        s.manifest.name.includes(q) ||
        s.manifest.description.toLowerCase().includes(q) ||
        s.manifest.tags.some((t) => t.toLowerCase().includes(q)),
    );
  }

// new:
  search(query: string): LoadedSkill[] {
    const tokens = extractQueryTokens(query);
    if (tokens.length === 0) return [];
    return this.getAll()
      .map((s) => ({
        skill: s,
        score: scoreKeywordMatch(tokens, {
          name: s.manifest.name,
          description: s.manifest.description,
          tags: s.manifest.tags,
        }),
      }))
      .filter(({ score }) => score > 0)
      .sort((a, b) => b.score - a.score)
      .map(({ skill }) => skill);
  }
```

- [ ] **Step 2: Build and run existing registry tests**

```bash
pnpm --filter @agentoctopus/registry build
pnpm --filter @agentoctopus/registry exec vitest run tests/registry.test.ts
```

The existing `search correctly filters skills by name or tag` test should still pass — the substring matches it tests ("fruit", "yellow") will still match via the token scoring.

- [ ] **Step 3: Commit**

```bash
git add packages/registry/src/registry.ts
git commit -m "feat(registry): upgrade search() to use scored token matching"
```

---

## Task 4: Deduplicate router.ts — import from skills instead of local copies

**Files:**

- Modify: `packages/core/src/router.ts:40-90`

- [ ] **Step 1: Add import from skills, remove local copies**

In `packages/core/src/router.ts`, add to the existing imports from `@agentoctopus/skills` (line 3):

```typescript
// Change line 3 from:
import { shouldIncludeSkill, type SkillEligibilityContext } from '@agentoctopus/skills';
// To:
import { shouldIncludeSkill, extractQueryTokens, scoreKeywordMatch, CJK_RANGE, type SkillEligibilityContext } from '@agentoctopus/skills';
```

Remove the local definitions (lines 40-90: `CJK_RANGE` constant, `extractQueryTokens`, `hasNonLatinChars`, `scoreKeywordMatch`).

`hasNonLatinChars` is still used by `route()` at line 279 — keep only that function. The comment blocks for `extractQueryTokens` and `scoreKeywordMatch` are removed (they now live in `@agentoctopus/skills`).

Note: `scoreKeywordMatch` previously took `LoadedSkill` — now it takes `SearchableSkill`. Update the call sites:

In `keywordFallback()` (line 483), the call:

```typescript
const keywordHits = scoreKeywordMatch(tokens, skill);
```

`skill` is `LoadedSkill` which has `manifest.name`, `manifest.description`, `manifest.tags` — wrap it:

```typescript
const keywordHits = scoreKeywordMatch(tokens, {
  name: skill.manifest.name,
  description: skill.manifest.description,
  tags: skill.manifest.tags,
});
```

Same for line 492:

```typescript
const withHits = scored.filter(s => scoreKeywordMatch(tokens, {
  name: s.skill.manifest.name,
  description: s.skill.manifest.description,
  tags: s.skill.manifest.tags,
}) > 0);
```

And line 377-383 (the cosine similarity keyword boost for non-embedded candidates):

```typescript
// Old:
const tokens = extractQueryTokens(routingQuery);
// ... later in the loop:
if (CJK_RANGE.test(t)) return name.includes(t);
```

This section at line 376-385 already uses `extractQueryTokens` and `CJK_RANGE` — these now come from the import.

- [ ] **Step 2: Build and run core tests**

```bash
pnpm --filter @agentoctopus/core build
pnpm --filter @agentoctopus/core test
```

- [ ] **Step 3: Commit**

```bash
git add packages/core/src/router.ts
git commit -m "refactor(core): use shared search utilities from @agentoctopus/skills"
```

---

## Task 5: Replace CLI `search` command with local search

**Files:**

- Modify: `apps/cli/src/index.ts:493-517`

- [ ] **Step 1: Replace the search command**

Remove the `searchSkills` import from line 13 (it came from `./clawhub.js`). The import line changes from:

```typescript
import { installSkill, searchSkills, fetchSkillMeta } from './clawhub.js';
```

To:

```typescript
import { installSkill, fetchSkillMeta } from './clawhub.js';
```

Replace the `search` command (lines 493-517) with:

```typescript
program
  .command('search [query]')
  .description('Search local skills')
  .option('--run', 'Interactively pick a skill and run a query against it')
  .action(async (query: string | undefined, options: { run?: boolean }) => {
    if (!query) {
      console.log(chalk.red('Provide a search query, e.g. "octopus search weather"'));
      return;
    }

    const spinner = ora('Searching local skills...').start();
    const { registry } = await bootstrap();
    const results = registry.search(query);
    spinner.stop();

    if (results.length === 0) {
      console.log(chalk.yellow(`\nNo skills found for "${query}".`));
      console.log(chalk.gray('Try "octopus list" to see all available skills.'));
      return;
    }

    // Display results
    console.log(chalk.bold(`\n🐙 Search Results for "${query}"\n`));
    results.forEach((skill, i) => {
      const rating = skill.rating;
      const stars = '★'.repeat(Math.round(rating)) + '☆'.repeat(5 - Math.round(rating));
      const desc = skill.manifest.description.length > 80
        ? skill.manifest.description.slice(0, 80) + '…'
        : skill.manifest.description;
      const tags = skill.manifest.tags.length > 0
        ? chalk.gray(`[${skill.manifest.tags.join(', ')}]`)
        : '';
      console.log(`  ${chalk.cyan.bold(`${i + 1}.`)} ${chalk.cyan.bold(skill.manifest.name)} ${chalk.yellow(stars)} ${chalk.gray(`(${skill.manifest.invocations} uses)`)}`);
      console.log(`     ${desc} ${tags}`);
      console.log();
    });

    // --run: interactive pick-and-run
    if (options.run) {
      const { router, executor } = await bootstrap();
      await router.buildIndex(registry.getAll());

      const rl = readline.createInterface({ input: process.stdin, output: process.stdout });

      const pickSkill = (): Promise<{ skill: typeof results[0]; query: string } | null> => {
        return new Promise((resolve) => {
          rl.question(chalk.yellow(`Pick a skill (1-${results.length}, or Enter to cancel): `), (answer) => {
            const trimmed = answer.trim();
            if (trimmed === '') {
              resolve(null);
              return;
            }
            const idx = parseInt(trimmed, 10);
            if (isNaN(idx) || idx < 1 || idx > results.length) {
              console.log(chalk.red(`Invalid choice. Pick 1-${results.length} or press Enter to cancel.`));
              resolve(pickSkill());
              return;
            }
            const skill = results[idx - 1]!;
            rl.question(chalk.yellow(`Query for ${skill.manifest.name} (or Enter to cancel): `), (query) => {
              if (query.trim() === '') {
                resolve(null);
              } else {
                resolve({ skill, query: query.trim() });
              }
            });
          });
        });
      };

      const pick = await pickSkill();
      if (!pick) {
        console.log(chalk.gray('Cancelled.'));
        rl.close();
        return;
      }

      console.log();
      const input = { query: pick.query, text: pick.query };
      const execSpinner = ora(`Executing ${pick.skill.manifest.name}...`).start();
      try {
        const result = await executor.execute(pick.skill, input);
        execSpinner.stop();

        if ('type' in result && result.type === 'credential_missing') {
          console.log(chalk.red(`\n${pick.skill.manifest.name} requires unconfigured API keys.`));
          const missingKeys = result.missing.map((v: { key: string }) => v.key);
          const guide = await executor.generateCredentialGuide(
            pick.skill.manifest.name,
            pick.skill.manifest.description,
            missingKeys,
          );
          console.log(chalk.yellow(guide.split('\n').map((l: string) => `  ${l}`).join('\n')));
        } else if ('type' in result && result.type === 'binary_missing') {
          const tools = (result.missing as string[]).map((b: string) => `  • ${b}`).join('\n');
          console.log(chalk.red(`\n${pick.skill.manifest.name} requires missing tools:`));
          console.log(tools);
        } else {
          const execResult = result as import('@agentoctopus/core').ExecutionResult;
          if (execResult.adapterResult.success) {
            console.log(chalk.green('\nResult:'));
            console.log(execResult.formattedOutput);
          } else {
            console.log(chalk.red(`\nExecution failed: ${execResult.adapterResult.error ?? 'Unknown error'}`));
          }
        }
      } catch (err) {
        execSpinner.fail(`Execution failed: ${(err as Error).message}`);
      }

      // Feedback prompt
      rl.question(chalk.yellow('\nWas this helpful? (y/n): '), (answer) => {
        const isPositive = answer.toLowerCase() === 'y' || answer.toLowerCase() === 'yes';
        rl.question(chalk.yellow('Any comments? (press Enter to skip): '), (comment) => {
          const trimmed = comment.trim() || undefined;
          registry.recordFeedback(pick.skill.manifest.name, isPositive, trimmed, 'cli');
          console.log(chalk.gray('Thank you for your feedback!'));
          rl.close();
        });
      });
    } else {
      console.log(chalk.gray('Use --run to pick a skill and run a query.'));
    }
  });
```

- [ ] **Step 2: Build the CLI**

```bash
pnpm --filter @agentoctopus/cli build
```

- [ ] **Step 3: Commit**

```bash
git add apps/cli/src/index.ts
git commit -m "feat(cli): replace remote search with local scored skill search + --run mode"
```

---

## Task 6: Update `octopus skill search` alias

**Files:**

- Modify: `apps/cli/src/index.ts:781-789`

- [ ] **Step 1: Update the skill search subcommand**

The current code at lines 781-789:

```typescript
skillCmd
  .command('search <query>')
  .description('Search for skills on ClaWHub')
  .option('--registry <url>', 'Custom ClaWHub registry URL')
  .action(async (query: string, options: { registry?: string }) => {
    const args = ['', '', 'search', query];
    if (options.registry) args.push('--registry', options.registry);
    await program.parseAsync(args, { from: 'user' });
  });
```

Replace with:

```typescript
skillCmd
  .command('search [query]')
  .description('Search local skills')
  .option('--run', 'Interactively pick a skill and run a query against it')
  .action(async (query: string | undefined, options: { run?: boolean }) => {
    const args = ['', '', 'search', ...(query ? [query] : [])];
    if (options.run) args.push('--run');
    await program.parseAsync(args, { from: 'user' });
  });
```

The changes: `<query>` → `[query]` (optional, matching the top-level command change), `--registry` removed, `--run` added, description updated.

- [ ] **Step 2: Build and verify**

```bash
pnpm --filter @agentoctopus/cli build
node apps/cli/dist/index.js skill search "weather"
```

Should produce the same output as `octopus search "weather"`.

- [ ] **Step 3: Commit**

```bash
git add apps/cli/src/index.ts
git commit -m "fix(cli): update skill search alias for local search with --run support"
```

---

## Task 7: Update documentation

**Files:**

- Modify: `README.md`
- Modify: `CLAUDE.md`
- Modify: `TEST_INSTRUCTIONS.md`
- Modify: `implementation_plan.md`
- Modify: `docs/api-reference/cli-reference.md`
- Modify: `docs/api-reference/rest-api.md`
- Modify: `docs/getting-started/quick-start.md`
- Modify: `docs/superpowers/specs/2026-04-29-agentoctopus-openclaw-skill-design.md`

- [ ] **Step 1: Update README.md**

Find the CLI commands section in README.md. Add `octopus search <query>` alongside `octopus list` and `octopus ask`:

```markdown
| `octopus search <query>` | Search local skills by name, description, and tags | `octopus search weather` |
| `octopus search <query> --run` | Search and interactively pick a skill to run | `octopus search weather --run` |
```

- [ ] **Step 2: Update CLAUDE.md**

In the Commands section of CLAUDE.md, update the `octopus search` description:

Change from referencing ClawHub remote search to local scored search, and add `--run` flag.

- [ ] **Step 3: Update TEST_INSTRUCTIONS.md**

Add test cases:

```markdown
| `octopus search "weather"` | Lists skills matching "weather" with names, ratings, descriptions | |
| `octopus search "nonexistent"` | Shows "No skills found" with hint to use `octopus list` | |
| `octopus search` (no query) | Shows error asking for a search query | |
| `octopus search "weather" --run` | Interactive pick-and-run flow after search results | |
```

- [ ] **Step 4: Update implementation_plan.md**

Mark any relevant phase items related to CLI search improvement as complete.

- [ ] **Step 5: Update docs/api-reference/cli-reference.md**

Change the `octopus search <query>` entry from "Search the skill marketplace" to "Search local skills by name, description, and tags. Results are scored and ranked by relevance." Add `--run` flag documentation.

Update `octopus skill search <query>` alias entry similarly.

- [ ] **Step 6: Update docs/api-reference/rest-api.md**

Add a note to `GET /api/marketplace?q=` entry: "Note: The CLI `octopus search` command searches local skills. Marketplace search is available via the REST API and `octopus sync`."

- [ ] **Step 7: Update docs/getting-started/quick-start.md**

Add an example after `octopus list`:

```bash
# Search for specific skills
octopus search "weather"
octopus search "translate" --run
```

- [ ] **Step 8: Update design spec doc**

Update `docs/superpowers/specs/2026-04-29-agentoctopus-openclaw-skill-design.md` — change `octopus search <query>` description from "find skills on ClawHub" to "search local skills".

- [ ] **Step 9: Commit all docs**

```bash
git add README.md CLAUDE.md TEST_INSTRUCTIONS.md implementation_plan.md docs/
git commit -m "docs: update documentation for local skill search feature"
```

---

## Task 8: Changeset, final build, and full test run

- [ ] **Step 1: Create a changeset**

```bash
pnpm changeset
```

Select "minor" bump for affected packages. Description: "Add local scored skill search — octopus search now searches installed skills with relevance scoring. Add --run flag for interactive pick-and-run execution."

- [ ] **Step 2: Build all packages**

```bash
pnpm build
```

- [ ] **Step 3: Run full test suite**

```bash
pnpm test
```

All 235+ tests must pass.

- [ ] **Step 4: Smoke test the CLI**

```bash
node apps/cli/dist/index.js search "weather"
node apps/cli/dist/index.js search "xyzzy"
node apps/cli/dist/index.js search
node apps/cli/dist/index.js skill search "translate"
```

- [ ] **Step 5: Commit changeset**

```bash
git add .changeset/
git commit -m "chore: add changeset for local skill search feature"
```
