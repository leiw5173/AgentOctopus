# Sync Output Optimization Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Reduce `octopus sync` output noise by showing only changed items, suppressing unchanged lines, auto-deleting stale skills, and adding a unified footer summary.

**Architecture:** The sync output lives entirely in `sync-skills.ts`. Phase 2 (`installAwesomeSkills`) is the main offender — it prints a line for every skill. Changes: suppress "already installed" lines, track counts per operation type, show only changed skills inline, delete local skills absent from the ClaWHub index, add a phase summary line. Phase 3 cloud sync gets the same treatment. The orchestrator (`runSync`) gets a unified footer combining all phases. Type definitions are extended to carry deleted/failed counts.

**Tech Stack:** TypeScript, chalk, Node.js fs

**Spec:** `docs/superpowers/specs/2026-04-25-sync-output-optimization-design.md`

---

### Task 1: Extend types with deleted/failed counters

**Files:**
- Modify: `apps/cli/src/sync-skills.ts:161-166` (AwesomeInstallResult)
- Modify: `apps/cli/src/sync-skills.ts:39-48` (SyncSkillsResult)

- [ ] **Step 1: Add `deleted` to `AwesomeInstallResult`**

```typescript
export interface AwesomeInstallResult {
  installed: number;
  skipped: number;
  deleted: number;
  failed: number;
  failedSlugs: string[];
}
```

Add `deleted: 0` to the initializer at line 184.

- [ ] **Step 2: Add `deleted` to `SyncSkillsResult` and initializer**

```typescript
export interface SyncSkillsResult {
  /** Phase 1 results */
  updatesAvailable: SkillUpdate[];
  skillsUpdated: string[];
  /** Phase 2 results */
  awesomeInstalled: number;
  awesomeSkipped: number;
  awesomeDeleted: number;
  awesomeFailed: number;
  /** Phase 3 results */
  cloudResult: SyncResult | null;
}
```

Add to initializer at line 322: `awesomeDeleted: 0, awesomeFailed: 0,`.

- [ ] **Step 3: Build and verify types compile**

```bash
pnpm --filter @agentoctopus/cli build
```

- [ ] **Step 4: Commit**

```bash
git add apps/cli/src/sync-skills.ts
git commit -m "feat(cli): add deleted/failed counters to sync result types"
```

---

### Task 2: Phase 2 — suppress unchanged, show only changes, delete stale

**Files:**
- Modify: `apps/cli/src/sync-skills.ts:220-242` (index path loop)
- Modify: `apps/cli/src/sync-skills.ts:383-387` (phase 2 summary in orchestrator)

- [ ] **Step 1: Change the "already exists" branch to suppress output**

Replace lines 224-230 (the `alreadyExists && !force` block):

```typescript
      const alreadyExists = fs.existsSync(path.join(options.skillsDir, entry.slug));
      if (alreadyExists && !options.force) {
        // Count files before patching to detect if anything changed
        let beforeCount = 0;
        const sd = path.join(options.skillsDir, entry.slug, 'scripts');
        if (fs.existsSync(sd)) {
          const walk = (d: string) => { for (const f of fs.readdirSync(d)) { const fp = path.join(d,f); fs.statSync(fp).isDirectory() ? walk(fp) : beforeCount++; } };
          walk(sd);
        }
        installFromIndex(entry, options.skillsDir, false);
        let afterCount = 0;
        if (fs.existsSync(sd)) {
          const walk = (d: string) => { for (const f of fs.readdirSync(d)) { const fp = path.join(d,f); fs.statSync(fp).isDirectory() ? walk(fp) : afterCount++; } };
          walk(sd);
        }
        if (afterCount > beforeCount) {
          console.log(`${prefix} ${chalk.green('✔')} ${chalk.cyan(entry.slug)} ${chalk.gray(`(updated — filled ${afterCount - beforeCount} missing files)`)}`);
          result.installed++;
        } else {
          result.skipped++;
        }
      } else {
        try {
          installFromIndex(entry, options.skillsDir, options.force);
          const status = alreadyExists ? 'updated' : 'new';
          console.log(`${prefix} ${chalk.green('✔')} ${chalk.cyan(entry.slug)} ${chalk.gray(`(${status})`)}`);
          result.installed++;
        } catch (err) {
          console.log(`${prefix} ${chalk.red('✘')} ${entry.slug} — ${chalk.red((err as Error).message)}`);
          result.failed++;
          result.failedSlugs.push(entry.slug);
        }
      }
```

- [ ] **Step 2: Add stale skill deletion after the for loop in the index path**

After the closing `}` of the for loop (line 242), and before `return result;`, add:

```typescript
    // Detect and delete stale skills not in the ClaWHub index
    if (!slugFilter && fs.existsSync(options.skillsDir)) {
      const localSlugs = fs.readdirSync(options.skillsDir).filter(
        (name) => fs.existsSync(path.join(options.skillsDir, name, 'SKILL.md')),
      );
      const indexSlugs = new Set(indexEntries.map((e) => e.slug));
      for (const slug of localSlugs) {
        if (!indexSlugs.has(slug)) {
          const dir = path.join(options.skillsDir, slug);
          if (options.dryRun) {
            console.log(`  ${chalk.red('✘')} ${slug} ${chalk.gray('(would delete — removed from registry)')}`);
          } else {
            fs.rmSync(dir, { recursive: true });
            console.log(`  ${chalk.red('✘')} ${slug} ${chalk.gray('(deleted — removed from registry)')}`);
          }
          result.deleted++;
        }
      }
    }
```

- [ ] **Step 3: Change the Phase 2 summary format in the orchestrator**

Replace the orchestrator's Phase 2 summary (lines 383-387):

```typescript
    const parts: string[] = [];
    if (awesomeResult.installed > 0) parts.push(`${awesomeResult.installed} added`);
    if (result.skillsUpdated.length > 0) parts.push(`${result.skillsUpdated.length} updated`);
    if (awesomeResult.deleted > 0) parts.push(`${awesomeResult.deleted} deleted`);
    if (awesomeResult.failed > 0) parts.push(`${awesomeResult.failed} failed`);
    if (awesomeResult.skipped > 0) parts.push(`${awesomeResult.skipped} unchanged`);
    console.log(chalk.bold(`\n  Phase 2: ${parts.join(', ')}`));
```

- [ ] **Step 4: Wire result counts from installAwesomeSkills into SyncSkillsResult**

In the orchestrator `runSync` (around lines 376-381), also capture `deleted` and `failed`:

```typescript
    result.awesomeInstalled = awesomeResult.installed;
    result.awesomeSkipped = awesomeResult.skipped;
    result.awesomeDeleted = awesomeResult.deleted;
    result.awesomeFailed = awesomeResult.failed;
```

- [ ] **Step 5: Build and verify**

```bash
pnpm --filter @agentoctopus/cli build
```

Expected: clean build, no type errors.

- [ ] **Step 6: Commit**

```bash
git add apps/cli/src/sync-skills.ts
git commit -m "feat(cli): suppress unchanged lines, show only changes, delete stale skills in Phase 2"
```

---

### Task 3: Phase 3 — compact cloud sync output

**Files:**
- Modify: `apps/cli/src/sync-skills.ts:403-414` (Phase 3 per-skill listings)

- [ ] **Step 1: Replace per-skill name listings with compact summary**

Replace lines 403-414:

```typescript
      const parts: string[] = [];
      if (result.cloudResult.added.length > 0) parts.push(`${result.cloudResult.added.length} added`);
      if (result.cloudResult.updated.length > 0) parts.push(`${result.cloudResult.updated.length} updated`);
      if (result.cloudResult.errors.length > 0) parts.push(`${result.cloudResult.errors.length} errors`);
      if (result.cloudResult.skipped.length > 0) parts.push(`${result.cloudResult.skipped.length} skipped`);
      console.log(`  Cloud (${options.cloudUrl}): ${parts.join(', ')}`);
```

Remove the old per-category name listing blocks (added, updated, skipped, errors).

- [ ] **Step 2: Build**

```bash
pnpm --filter @agentoctopus/cli build
```

- [ ] **Step 3: Commit**

```bash
git add apps/cli/src/sync-skills.ts
git commit -m "feat(cli): compact Phase 3 cloud sync output — summary only, no per-skill names"
```

---

### Task 4: Unified footer

**Files:**
- Modify: `apps/cli/src/sync-skills.ts:420-427` (footer)

- [ ] **Step 1: Replace old footer with unified format**

Replace lines 420-427 (the old summary):

```typescript
  // Unified footer
  const totalAdded = result.awesomeInstalled + (result.cloudResult?.added.length ?? 0);
  const totalUpdated = result.skillsUpdated.length + (result.cloudResult?.updated.length ?? 0);
  const totalDeleted = result.awesomeDeleted;
  const totalUnchanged = result.awesomeSkipped + (result.cloudResult?.skipped.length ?? 0);
  const totalFailed = result.awesomeFailed + (result.cloudResult?.errors.length ?? 0);

  const footerParts: string[] = [];
  if (totalAdded > 0) footerParts.push(`${chalk.green(totalAdded)} added`);
  if (totalUpdated > 0) footerParts.push(`${chalk.cyan(totalUpdated)} updated`);
  if (totalDeleted > 0) footerParts.push(`${chalk.red(totalDeleted)} deleted`);
  if (totalUnchanged > 0) footerParts.push(`${chalk.gray(totalUnchanged)} unchanged`);
  if (totalFailed > 0) footerParts.push(`${chalk.red(totalFailed)} failed`);

  if (footerParts.length > 0) {
    console.log(chalk.bold(`\n${chalk.gray('━━━━━━━━━━━━━━━━━━━━━━━━━━━━')}`));
    console.log(chalk.bold(`Sync: ${footerParts.join(', ')}`));
  }
```

- [ ] **Step 2: Build**

```bash
pnpm --filter @agentoctopus/cli build
```

- [ ] **Step 3: Commit**

```bash
git add apps/cli/src/sync-skills.ts
git commit -m "feat(cli): add unified sync footer combining all phases"
```

---

### Task 5: Update tests

**Files:**
- Modify: `apps/cli/tests/sync-skills.test.ts`

- [ ] **Step 1: Add test for stale skill detection/deletion**

Add a new `describe` block:

```typescript
describe('installAwesomeSkills — deleted', () => {
  let fetchSpy: ReturnType<typeof vi.spyOn>;
  let tmpDir: string;

  beforeEach(() => {
    fetchSpy = vi.spyOn(globalThis, 'fetch');
    tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'octopus-sync-del-'));
  });

  afterEach(() => {
    fetchSpy.mockRestore();
    fs.rmSync(tmpDir, { recursive: true });
  });

  it('deletes local skills not present in the index', async () => {
    // Create a stale local skill
    const staleDir = path.join(tmpDir, 'stale-skill');
    fs.mkdirSync(staleDir, { recursive: true });
    fs.writeFileSync(path.join(staleDir, 'SKILL.md'), '---\nname: stale-skill\nversion: 1.0.0\n---');

    // Index with only one skill — NOT stale-skill
    const skills = [
      {
        slug: 'good-skill',
        name: 'Good Skill',
        description: 'desc',
        version: '1.0.0',
        author: 'alice',
        skillMd: '---\nname: good-skill\nversion: 1.0.0\n---\n\n# Good',
        metaJson: '{}',
        invokeScript: null,
        scripts: null,
        files: null,
      },
    ];
    const gz = makeIndexGz(skills);
    fetchSpy.mockResolvedValueOnce({
      ok: true,
      status: 200,
      arrayBuffer: async () => gz.buffer.slice(gz.byteOffset, gz.byteOffset + gz.byteLength),
    } as unknown as Response);

    const { installAwesomeSkills } = await import('../src/sync-skills.js');
    const result = await installAwesomeSkills({
      skillsDir: tmpDir,
      force: false,
    });

    expect(result.deleted).toBe(1);
    expect(fs.existsSync(staleDir)).toBe(false);
    expect(fs.existsSync(path.join(tmpDir, 'good-skill'))).toBe(true);
  });
});
```

Add the import for `installAwesomeSkills` at top of the test file —add to line 5 import:

```typescript
import { checkSkillUpdates, applySkillUpdates, installAwesomeSkills } from '../src/sync-skills.js';
```

Wait — `installAwesomeSkills` isnot currently exported in the import line. Check if it needs to be added. Let me look at line 5 — yes, update the import to include `installAwesomeSkills`.

- [ ] **Step 2: Run tests to verify they pass**

```bash
pnpm --filter @agentoctopus/cli test
```

Expected: 42 tests pass (1 new test added)

- [ ] **Step 3: Commit**

```bash
git add apps/cli/tests/sync-skills.test.ts
git commit -m "test(cli): add stale skill deletion test for sync"
```

---

### Task 6: Final verification

- [ ] **Step 1: Run full test suite**

```bash
pnpm test
```

Expected: All tests pass (registry may SIGABRT on teardown — known Node.js issue).

- [ ] **Step 2: Run a real sync to verify output**

```bash
node apps/cli/dist/index.js sync --check 2>&1 | head -30
```

Expected: Only skills with updates shown, no "already installed" noise.

- [ ] **Step 3: Final commit if any docs need updating**

Follow CLAUDE.md rule 2 — check if `README.md`, `TEST_INSTRUCTIONS.md`, or `docs/` need updates for the output format change.
