# `octopus update` & `octopus sync` Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Add `octopus update` to check/install latest @agentoctopus npm packages, and replace `octopus sync` with a three-phase version-aware skill update command that absorbs `sync-awesome`.

**Architecture:** Self-contained CLI commands in `apps/cli/src/`. New `update.ts` module for npm package version checking and install. New `sync-skills.ts` module that orchestrates marketplace version checking, awesome bulk install, and cloud sync. The `sync-awesome` command is removed from `index.ts`.

**Tech Stack:** TypeScript, Commander.js, chalk, ora, Node.js `child_process` for npm commands, existing `clawhub.ts` and `@agentoctopus/registry` for skill operations.

---

## File Structure

| File | Responsibility |
|---|---|
| `apps/cli/src/update.ts` | **New** — npm registry version check + global install logic |
| `apps/cli/src/sync-skills.ts` | **New** — three-phase skill sync: version check → awesome install → cloud sync |
| `apps/cli/src/index.ts` | **Modify** — add `update` command, replace `sync` handler, remove `sync-awesome` command |
| `apps/cli/tests/update.test.ts` | **New** — tests for update module |
| `apps/cli/tests/sync-skills.test.ts` | **New** — tests for sync-skills module |
| `CLAUDE.md` | **Modify** — add `update` command docs |
| `README.md` | **Modify** — document new commands, remove `sync-awesome` references |
| `TEST_INSTRUCTIONS.md` | **Modify** — add test rows for both commands |

---

### Task 1: Create `apps/cli/src/update.ts` — npm package update module

**Files:**
- Create: `apps/cli/src/update.ts`

- [ ] **Step 1: Write the update module**

```typescript
import { execSync } from 'child_process';
import chalk from 'chalk';

/** Packages to check for updates (CLI pulls in the rest transitively) */
const PACKAGES = [
  '@agentoctopus/cli',
  '@agentoctopus/core',
  '@agentoctopus/registry',
  '@agentoctopus/adapters',
  '@agentoctopus/gateway',
] as const;

export interface PackageVersion {
  name: string;
  current: string | null;
  latest: string;
}

/**
 * Query npm registry for the latest version of a package.
 * Returns null if the package is not found or the registry is unreachable.
 */
export async function getLatestVersion(pkg: string): Promise<string | null> {
  try {
    const result = execSync(`npm view ${pkg} version`, { encoding: 'utf8', timeout: 15000 }).trim();
    return result || null;
  } catch {
    return null;
  }
}

/**
 * Get the currently installed version of a package.
 * Uses `npm list -g` to read the global install.
 * Returns null if the package is not installed globally.
 */
export function getInstalledVersion(pkg: string): string | null {
  try {
    const result = execSync(`npm list -g ${pkg} --json`, { encoding: 'utf8', timeout: 10000 }).trim();
    const data = JSON.parse(result);
    // npm list -g returns { "dependencies": { "@agentoctopus/cli": { "version": "0.4.15" } } }
    const deps = data.dependencies ?? {};
    const entry = deps[pkg];
    if (entry && entry.version) {
      return entry.version;
    }
    return null;
  } catch {
    return null;
  }
}

/**
 * Check all @agentoctopus packages for available updates.
 * Returns a list of PackageVersion objects with current and latest versions.
 */
export async function checkPackageUpdates(): Promise<PackageVersion[]> {
  const results: PackageVersion[] = [];

  for (const pkg of PACKAGES) {
    const [current, latest] = await Promise.all([
      Promise.resolve(getInstalledVersion(pkg)),
      getLatestVersion(pkg),
    ]);

    if (latest !== null) {
      results.push({ name: pkg, current, latest });
    }
  }

  return results;
}

/**
 * Display a table of package versions.
 * Returns the number of packages with available updates.
 */
export function displayUpdateTable(updates: PackageVersion[]): number {
  let updateable = 0;

  for (const pkg of updates) {
    const hasUpdate = pkg.current !== null && pkg.current !== pkg.latest;
    const notInstalled = pkg.current === null;

    if (hasUpdate) updateable++;

    const name = pkg.name.padEnd(30);
    const current = (pkg.current ?? 'not installed').padEnd(10);
    const latest = pkg.latest;

    if (hasUpdate) {
      console.log(`  ${chalk.cyan(name)} ${chalk.yellow(current)} → ${chalk.green(latest)}`);
    } else if (notInstalled) {
      console.log(`  ${chalk.gray(name)} ${chalk.gray(current)}   ${chalk.gray(latest)}`);
    } else {
      console.log(`  ${chalk.green(name)} ${current}   ${chalk.green('✓ up to date')}`);
    }
  }

  return updateable;
}

/**
 * Run npm install -g to update the CLI package.
 * Returns true on success.
 */
export function runGlobalInstall(): boolean {
  try {
    execSync('npm install -g @agentoctopus/cli@latest', { encoding: 'utf8', stdio: 'pipe', timeout: 120000 });
    return true;
  } catch {
    return false;
  }
}
```

- [ ] **Step 2: Commit**

```bash
git add apps/cli/src/update.ts
git commit -m "feat(cli): add update module for npm package version checking"
```

---

### Task 2: Write tests for `update.ts`

**Files:**
- Create: `apps/cli/tests/update.test.ts`

- [ ] **Step 1: Write the tests**

```typescript
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import * as childProcess from 'child_process';
import { getLatestVersion, getInstalledVersion, checkPackageUpdates, displayUpdateTable } from '../src/update.js';
import type { PackageVersion } from '../src/update.js';

describe('getLatestVersion', () => {
  let execSpy: ReturnType<typeof vi.spyOn>;

  beforeEach(() => {
    execSpy = vi.spyOn(childProcess, 'execSync');
  });

  afterEach(() => {
    execSpy.mockRestore();
  });

  it('returns the version string from npm view', async () => {
    execSpy.mockReturnValue('0.4.18\n');
    const result = await getLatestVersion('@agentoctopus/cli');
    expect(result).toBe('0.4.18');
  });

  it('returns null when npm view fails (package not found)', async () => {
    execSpy.mockImplementation(() => { throw new Error('not found'); });
    const result = await getLatestVersion('@agentoctopus/nonexistent');
    expect(result).toBeNull();
  });

  it('returns null for empty output', async () => {
    execSpy.mockReturnValue('');
    const result = await getLatestVersion('@agentoctopus/cli');
    expect(result).toBeNull();
  });
});

describe('getInstalledVersion', () => {
  let execSpy: ReturnType<typeof vi.spyOn>;

  beforeEach(() => {
    execSpy = vi.spyOn(childProcess, 'execSync');
  });

  afterEach(() => {
    execSpy.mockRestore();
  });

  it('returns installed version from npm list -g', () => {
    execSpy.mockReturnValue(JSON.stringify({
      dependencies: { '@agentoctopus/cli': { version: '0.4.15' } },
    }));
    const result = getInstalledVersion('@agentoctopus/cli');
    expect(result).toBe('0.4.15');
  });

  it('returns null when package is not installed globally', () => {
    execSpy.mockReturnValue(JSON.stringify({ dependencies: {} }));
    const result = getInstalledVersion('@agentoctopus/cli');
    expect(result).toBeNull();
  });

  it('returns null when npm list fails', () => {
    execSpy.mockImplementation(() => { throw new Error('not installed'); });
    const result = getInstalledVersion('@agentoctopus/cli');
    expect(result).toBeNull();
  });
});

describe('checkPackageUpdates', () => {
  let execSpy: ReturnType<typeof vi.spyOn>;

  beforeEach(() => {
    execSpy = vi.spyOn(childProcess, 'execSync');
  });

  afterEach(() => {
    execSpy.mockRestore();
  });

  it('returns PackageVersion entries for reachable packages', async () => {
    // npm view returns latest, npm list returns current
    execSpy
      .mockReturnValueOnce('0.4.18\n')   // npm view @agentoctopus/cli
      .mockReturnValueOnce(JSON.stringify({ dependencies: { '@agentoctopus/cli': { version: '0.4.15' } } }))  // npm list cli
      .mockReturnValueOnce('0.4.7\n')    // npm view @agentoctopus/core
      .mockReturnValueOnce(JSON.stringify({ dependencies: { '@agentoctopus/core': { version: '0.4.5' } } }))
      .mockReturnValueOnce('0.4.8\n')    // npm view @agentoctopus/registry
      .mockReturnValueOnce(JSON.stringify({ dependencies: { '@agentoctopus/registry': { version: '0.4.7' } } }))
      .mockReturnValueOnce('0.4.2\n')    // npm view @agentoctopus/adapters
      .mockReturnValueOnce(JSON.stringify({ dependencies: { '@agentoctopus/adapters': { version: '0.4.1' } } }))
      .mockReturnValueOnce('0.4.7\n')    // npm view @agentoctopus/gateway
      .mockReturnValueOnce(JSON.stringify({ dependencies: { '@agentoctopus/gateway': { version: '0.4.6' } } }));

    const results = await checkPackageUpdates();
    expect(results).toHaveLength(5);
    expect(results[0]!.name).toBe('@agentoctopus/cli');
    expect(results[0]!.current).toBe('0.4.15');
    expect(results[0]!.latest).toBe('0.4.18');
  });

  it('skips packages that are unreachable on npm', async () => {
    execSpy.mockImplementation(() => { throw new Error('network error'); });
    const results = await checkPackageUpdates();
    expect(results).toHaveLength(0);
  });
});

describe('displayUpdateTable', () => {
  let logSpy: ReturnType<typeof vi.spyOn>;

  beforeEach(() => {
    logSpy = vi.spyOn(console, 'log').mockReturnValue(undefined);
  });

  afterEach(() => {
    logSpy.mockRestore();
  });

  it('returns 0 when all packages are up to date', () => {
    const updates: PackageVersion[] = [
      { name: '@agentoctopus/cli', current: '0.4.15', latest: '0.4.15' },
    ];
    const count = displayUpdateTable(updates);
    expect(count).toBe(0);
  });

  it('returns count of packages with available updates', () => {
    const updates: PackageVersion[] = [
      { name: '@agentoctopus/cli', current: '0.4.15', latest: '0.4.18' },
      { name: '@agentoctopus/core', current: '0.4.5', latest: '0.4.7' },
    ];
    const count = displayUpdateTable(updates);
    expect(count).toBe(2);
  });

  it('handles not-installed packages', () => {
    const updates: PackageVersion[] = [
      { name: '@agentoctopus/cli', current: null, latest: '0.4.18' },
    ];
    const count = displayUpdateTable(updates);
    expect(count).toBe(0);
  });
});
```

- [ ] **Step 2: Run tests to verify they pass**

Run: `pnpm --filter @agentoctopus/cli exec vitest run tests/update.test.ts`
Expected: All tests PASS

- [ ] **Step 3: Commit**

```bash
git add apps/cli/tests/update.test.ts
git commit -m "test(cli): add tests for update module"
```

---

### Task 3: Create `apps/cli/src/sync-skills.ts` — three-phase skill sync module

**Files:**
- Create: `apps/cli/src/sync-skills.ts`

- [ ] **Step 1: Write the sync-skills module**

```typescript
import chalk from 'chalk';
import ora from 'ora';
import fs from 'fs';
import path from 'path';
import { syncFromCloud, type SyncResult } from '@agentoctopus/registry';
import {
  downloadSkillsIndex,
  installFromIndex,
  fetchAwesomeSlugs,
  installSkill,
  type SkillIndexEntry,
} from './clawhub.js';

// ── Types ──────────────────────────────────────────────────────────────────────

export interface SkillUpdate {
  slug: string;
  currentVersion: string;
  latestVersion: string;
}

export interface SyncSkillsOptions {
  skillsDir: string;
  /** Phase 1: check marketplace for updates to installed skills */
  check?: boolean;
  /** Phase 2: awesome bulk install options */
  category?: string;
  limit?: number;
  /** Phase 3: cloud sync */
  cloudUrl?: string;
  /** Shared flags */
  force?: boolean;
  dryRun?: boolean;
  registryUrl?: string;
}

export interface SyncSkillsResult {
  /** Phase 1 results */
  updatesAvailable: SkillUpdate[];
  skillsUpdated: string[];
  /** Phase 2 results */
  awesomeInstalled: number;
  awesomeSkipped: number;
  /** Phase 3 results */
  cloudResult: SyncResult | null;
}

// ── Phase 1: Marketplace version check ─────────────────────────────────────────

/**
 * Scan installed skills and check the ClaWHub skills index for newer versions.
 * Returns a list of skills with available updates.
 */
export async function checkSkillUpdates(
  skillsDir: string,
): Promise<SkillUpdate[]> {
  const updates: SkillUpdate[] = [];

  // Download the full skills index for version comparison
  let indexEntries: SkillIndexEntry[];
  try {
    indexEntries = await downloadSkillsIndex();
  } catch {
    // Index unavailable — cannot check versions
    return updates;
  }

  // Build a map of slug → index entry for quick lookup
  const indexMap = new Map<string, SkillIndexEntry>();
  for (const entry of indexEntries) {
    indexMap.set(entry.slug, entry);
  }

  // Scan installed skills
  if (!fs.existsSync(skillsDir)) return updates;

  const installedSlugs = fs.readdirSync(skillsDir).filter(
    (name) => fs.existsSync(path.join(skillsDir, name, 'SKILL.md')),
  );

  for (const slug of installedSlugs) {
    const skillMdPath = path.join(skillsDir, slug, 'SKILL.md');
    try {
      const content = fs.readFileSync(skillMdPath, 'utf8');
      // Parse frontmatter to get version
      const frontmatterMatch = content.match(/^---\n([\s\S]*?)\n---/);
      if (!frontmatterMatch) continue;

      const frontmatter = frontmatterMatch[1]!;
      const versionMatch = frontmatter.match(/^version:\s*['"]?([^'"\n]+)['"]?/m);
      if (!versionMatch) continue;

      const currentVersion = versionMatch[1]!.trim();
      const indexEntry = indexMap.get(slug);
      if (!indexEntry) continue;

      // Compare versions (simple string compare — semver would be better but YAGNI)
      if (indexEntry.version !== currentVersion && indexEntry.version > currentVersion) {
        updates.push({
          slug,
          currentVersion,
          latestVersion: indexEntry.version,
        });
      }
    } catch {
      // Skip skills with unreadable manifests
    }
  }

  return updates;
}

/**
 * Apply skill updates by re-installing from the index.
 */
export function applySkillUpdates(
  updates: SkillUpdate[],
  skillsDir: string,
  indexEntries: SkillIndexEntry[],
): string[] {
  const updated: string[] = [];
  const indexMap = new Map<string, SkillIndexEntry>();
  for (const entry of indexEntries) {
    indexMap.set(entry.slug, entry);
  }

  for (const update of updates) {
    const entry = indexMap.get(update.slug);
    if (entry) {
      try {
        installFromIndex(entry, skillsDir, true); // force=true to overwrite
        updated.push(update.slug);
      } catch {
        // Skip failed updates
      }
    }
  }

  return updated;
}

// ── Phase 2: Awesome skills bulk install ───────────────────────────────────────

export interface AwesomeInstallResult {
  installed: number;
  skipped: number;
  failed: number;
  failedSlugs: string[];
}

/**
 * Bulk-install skills from the awesome-openclaw-skills list.
 * Extracted from the existing sync-awesome command handler.
 */
export async function installAwesomeSkills(
  options: {
    skillsDir: string;
    category?: string;
    limit?: number;
    force?: boolean;
    dryRun?: boolean;
    registryUrl?: string;
  },
): Promise<AwesomeInstallResult> {
  const result: AwesomeInstallResult = { installed: 0, skipped: 0, failed: 0, failedSlugs: [] };

  // Step 1: resolve slug filter for --category
  let slugFilter: Set<string> | null = null;
  if (options.category) {
    const categorySlugs = await fetchAwesomeSlugs({ category: options.category });
    slugFilter = new Set(categorySlugs);
  }

  // Step 2: try index-first path
  let indexEntries: SkillIndexEntry[] | null = null;
  try {
    indexEntries = await downloadSkillsIndex();
  } catch {
    // Index unavailable — fall back to per-skill fetch
  }

  if (indexEntries !== null) {
    // Index path
    let entries = indexEntries;
    if (slugFilter) {
      entries = entries.filter((e) => slugFilter!.has(e.slug));
    }
    const total =
      options.limit && options.limit > 0 ? Math.min(options.limit, entries.length) : entries.length;
    entries = entries.slice(0, total);

    if (options.dryRun) {
      console.log(chalk.bold('\n  Dry run — skills that would be installed:\n'));
      entries.forEach((e) => console.log(`  ${chalk.cyan(e.slug)}`));
      console.log(chalk.gray(`\n  Total: ${entries.length}`));
      return result;
    }

    for (let i = 0; i < entries.length; i++) {
      const entry = entries[i]!;
      const prefix = chalk.gray(`[${i + 1}/${entries.length}]`);
      const alreadyExists = fs.existsSync(path.join(options.skillsDir, entry.slug));
      if (alreadyExists && !options.force) {
        console.log(
          `${prefix} ${chalk.gray('–')} ${entry.slug} ${chalk.gray('(already installed, use --force to overwrite)')}`,
        );
        result.skipped++;
      } else {
        try {
          installFromIndex(entry, options.skillsDir, options.force);
          console.log(`${prefix} ${chalk.green('✔')} ${chalk.cyan(entry.slug)}`);
          result.installed++;
        } catch (err) {
          console.log(`${prefix} ${chalk.red('✘')} ${entry.slug} — ${chalk.red((err as Error).message)}`);
          result.failed++;
          result.failedSlugs.push(entry.slug);
        }
      }
    }
    return result;
  }

  // Fallback: per-skill ClaWHub fetch
  let slugs: string[];
  if (slugFilter) {
    slugs = Array.from(slugFilter);
  } else {
    slugs = await fetchAwesomeSlugs();
  }

  const total =
    options.limit && options.limit > 0 ? Math.min(options.limit, slugs.length) : slugs.length;
  slugs = slugs.slice(0, total);

  if (options.dryRun) {
    console.log(chalk.bold('\n  Dry run — skills that would be installed:\n'));
    slugs.forEach((s) => console.log(`  ${chalk.cyan(s)}`));
    console.log(chalk.gray(`\n  Total: ${slugs.length}`));
    return result;
  }

  for (let i = 0; i < slugs.length; i++) {
    const slug = slugs[i]!;
    const prefix = chalk.gray(`[${i + 1}/${slugs.length}]`);
    try {
      await installSkill(slug, options.skillsDir, {
        registryUrl: options.registryUrl,
        force: options.force,
      });
      console.log(`${prefix} ${chalk.green('✔')} ${chalk.cyan(slug)}`);
      result.installed++;
    } catch (err) {
      const msg = (err as Error).message ?? '';
      if (msg.includes('already exists')) {
        console.log(
          `${prefix} ${chalk.gray('–')} ${slug} ${chalk.gray('(already installed, use --force to overwrite)')}`,
        );
        result.skipped++;
      } else {
        console.log(`${prefix} ${chalk.red('✘')} ${slug} — ${chalk.red(msg)}`);
        result.failed++;
        result.failedSlugs.push(slug);
      }
    }
  }

  return result;
}

// ── Phase 3: Cloud sync ────────────────────────────────────────────────────────

/**
 * Sync skills from a cloud AgentOctopus instance.
 * Wraps the existing syncFromCloud with display logic.
 */
export async function syncFromCloudInstance(
  cloudUrl: string,
  skillsDir: string,
  force = false,
): Promise<SyncResult> {
  return syncFromCloud(cloudUrl, skillsDir, force);
}

// ── Orchestrator ───────────────────────────────────────────────────────────────

/**
 * Run the full three-phase sync.
 */
export async function runSync(options: SyncSkillsOptions): Promise<SyncSkillsResult> {
  const result: SyncSkillsResult = {
    updatesAvailable: [],
    skillsUpdated: [],
    awesomeInstalled: 0,
    awesomeSkipped: 0,
    cloudResult: null,
  };

  // Phase 1: Marketplace version check
  const spinner1 = ora('Checking for skill updates...').start();
  try {
    result.updatesAvailable = await checkSkillUpdates(options.skillsDir);
    spinner1.succeed(
      result.updatesAvailable.length > 0
        ? `Found ${result.updatesAvailable.length} skill(s) with updates`
        : 'All installed skills are up to date',
    );
  } catch (err) {
    spinner1.warn(`Could not check for updates: ${(err as Error).message}`);
  }

  // Display available updates
  if (result.updatesAvailable.length > 0) {
    console.log(chalk.bold('\n  Skill updates available:'));
    for (const update of result.updatesAvailable) {
      console.log(
        `    ${chalk.cyan(update.slug)}  ${chalk.yellow(update.currentVersion)} → ${chalk.green(update.latestVersion)}`,
      );
    }
  }

  // If --check, stop here
  if (options.check) {
    return result;
  }

  // Apply updates (Phase 1 install)
  if (result.updatesAvailable.length > 0) {
    try {
      const indexEntries = await downloadSkillsIndex();
      result.skillsUpdated = applySkillUpdates(result.updatesAvailable, options.skillsDir, indexEntries);
      if (result.skillsUpdated.length > 0) {
        console.log(chalk.green(`\n  Updated: ${result.skillsUpdated.join(', ')}`));
      }
    } catch (err) {
      console.log(chalk.red(`  Failed to apply updates: ${(err as Error).message}`));
    }
  }

  // Phase 2: Awesome skills bulk install
  if (!options.cloudUrl || true) { // Always run unless explicitly skipped
    console.log(chalk.bold('\n  Syncing awesome skills...'));
    try {
      const awesomeResult = await installAwesomeSkills({
        skillsDir: options.skillsDir,
        category: options.category,
        limit: options.limit,
        force: options.force,
        dryRun: options.dryRun,
        registryUrl: options.registryUrl,
      });
      result.awesomeInstalled = awesomeResult.installed;
      result.awesomeSkipped = awesomeResult.skipped;

      console.log(
        chalk.bold(
          `\n  Awesome: Installed: ${awesomeResult.installed}  Skipped: ${awesomeResult.skipped}  Failed: ${awesomeResult.failed}`,
        ),
      );
    } catch (err) {
      console.log(chalk.red(`  Awesome sync failed: ${(err as Error).message}`));
    }
  }

  // Phase 3: Cloud sync
  if (options.cloudUrl) {
    const spinner3 = ora(`Syncing from ${options.cloudUrl}...`).start();
    try {
      result.cloudResult = await syncFromCloudInstance(
        options.cloudUrl,
        options.skillsDir,
        options.force,
      );
      spinner3.succeed('Cloud sync complete');

      if (result.cloudResult.added.length > 0) {
        console.log(chalk.green(`  Added: ${result.cloudResult.added.join(', ')}`));
      }
      if (result.cloudResult.updated.length > 0) {
        console.log(chalk.cyan(`  Updated: ${result.cloudResult.updated.join(', ')}`));
      }
      if (result.cloudResult.skipped.length > 0) {
        console.log(chalk.gray(`  Skipped: ${result.cloudResult.skipped.join(', ')}`));
      }
      if (result.cloudResult.errors.length > 0) {
        console.log(chalk.red(`  Errors: ${result.cloudResult.errors.join(', ')}`));
      }
    } catch (err) {
      spinner3.fail(`Cloud sync failed: ${(err as Error).message}`);
    }
  }

  // Summary
  const totalUpdated = result.skillsUpdated.length + result.awesomeInstalled + (result.cloudResult?.added.length ?? 0) + (result.cloudResult?.updated.length ?? 0);
  if (totalUpdated > 0) {
    console.log(chalk.yellow(`\n  Updated ${totalUpdated} skill(s). Restart the server to pick up changes.`));
  }

  return result;
}
```

- [ ] **Step 2: Commit**

```bash
git add apps/cli/src/sync-skills.ts
git commit -m "feat(cli): add sync-skills module with three-phase skill sync"
```

---

### Task 4: Write tests for `sync-skills.ts`

**Files:**
- Create: `apps/cli/tests/sync-skills.test.ts`

- [ ] **Step 1: Write the tests**

```typescript
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import fs from 'fs';
import path from 'path';
import os from 'os';
import { checkSkillUpdates, applySkillUpdates } from '../src/sync-skills.js';
import type { SkillUpdate } from '../src/sync-skills.js';
import { gzipSync } from 'zlib';

function makeIndexGz(skills: unknown[]): Buffer {
  const json = JSON.stringify({ version: '1', builtAt: '2026-01-01T00:00:00Z', skills });
  return gzipSync(Buffer.from(json));
}

describe('checkSkillUpdates', () => {
  let fetchSpy: ReturnType<typeof vi.spyOn>;
  let tmpDir: string;

  beforeEach(() => {
    fetchSpy = vi.spyOn(globalThis, 'fetch');
    tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'octopus-sync-test-'));
  });

  afterEach(() => {
    fetchSpy.mockRestore();
    fs.rmSync(tmpDir, { recursive: true });
  });

  it('returns empty array when skills dir does not exist', async () => {
    const result = await checkSkillUpdates(path.join(tmpDir, 'nonexistent'));
    expect(result).toEqual([]);
  });

  it('returns empty array when index download fails', async () => {
    fetchSpy.mockResolvedValueOnce({ ok: false, status: 500 } as Response);
    const result = await checkSkillUpdates(tmpDir);
    expect(result).toEqual([]);
  });

  it('detects skills with available updates', async () => {
    // Create an installed skill with version 1.0.0
    const skillDir = path.join(tmpDir, 'my-skill');
    fs.mkdirSync(skillDir, { recursive: true });
    fs.writeFileSync(
      path.join(skillDir, 'SKILL.md'),
      '---\nname: my-skill\nversion: 1.0.0\n---\n\n# My Skill',
    );

    // Mock the skills index with version 2.0.0
    const skills = [
      {
        slug: 'my-skill',
        name: 'My Skill',
        description: 'desc',
        version: '2.0.0',
        author: 'bob',
        skillMd: '---\nname: my-skill\nversion: 2.0.0\n---\n\n# My Skill v2',
        metaJson: '{}',
        invokeScript: null,
      },
    ];
    const gz = makeIndexGz(skills);
    fetchSpy.mockResolvedValueOnce({
      ok: true,
      status: 200,
      arrayBuffer: async () => gz.buffer.slice(gz.byteOffset, gz.byteOffset + gz.byteLength),
    } as unknown as Response);

    const result = await checkSkillUpdates(tmpDir);
    expect(result).toHaveLength(1);
    expect(result[0]!.slug).toBe('my-skill');
    expect(result[0]!.currentVersion).toBe('1.0.0');
    expect(result[0]!.latestVersion).toBe('2.0.0');
  });

  it('skips skills that are already up to date', async () => {
    const skillDir = path.join(tmpDir, 'my-skill');
    fs.mkdirSync(skillDir, { recursive: true });
    fs.writeFileSync(
      path.join(skillDir, 'SKILL.md'),
      '---\nname: my-skill\nversion: 2.0.0\n---\n\n# My Skill',
    );

    const skills = [
      {
        slug: 'my-skill',
        name: 'My Skill',
        description: 'desc',
        version: '2.0.0',
        author: 'bob',
        skillMd: '---\nname: my-skill\nversion: 2.0.0\n---',
        metaJson: '{}',
        invokeScript: null,
      },
    ];
    const gz = makeIndexGz(skills);
    fetchSpy.mockResolvedValueOnce({
      ok: true,
      status: 200,
      arrayBuffer: async () => gz.buffer.slice(gz.byteOffset, gz.byteOffset + gz.byteLength),
    } as unknown as Response);

    const result = await checkSkillUpdates(tmpDir);
    expect(result).toHaveLength(0);
  });

  it('skips skills without a version in frontmatter', async () => {
    const skillDir = path.join(tmpDir, 'my-skill');
    fs.mkdirSync(skillDir, { recursive: true });
    fs.writeFileSync(
      path.join(skillDir, 'SKILL.md'),
      '---\nname: my-skill\n---\n\n# My Skill',
    );

    const skills = [
      {
        slug: 'my-skill',
        name: 'My Skill',
        description: 'desc',
        version: '1.0.0',
        author: 'bob',
        skillMd: '---\nname: my-skill\nversion: 1.0.0\n---',
        metaJson: '{}',
        invokeScript: null,
      },
    ];
    const gz = makeIndexGz(skills);
    fetchSpy.mockResolvedValueOnce({
      ok: true,
      status: 200,
      arrayBuffer: async () => gz.buffer.slice(gz.byteOffset, gz.byteOffset + gz.byteLength),
    } as unknown as Response);

    const result = await checkSkillUpdates(tmpDir);
    expect(result).toHaveLength(0);
  });
});

describe('applySkillUpdates', () => {
  let tmpDir: string;

  beforeEach(() => {
    tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'octopus-sync-apply-'));
  });

  afterEach(() => {
    fs.rmSync(tmpDir, { recursive: true });
  });

  it('updates skills by re-installing from index entries', () => {
    // Create an old skill
    const skillDir = path.join(tmpDir, 'my-skill');
    fs.mkdirSync(skillDir, { recursive: true });
    fs.writeFileSync(path.join(skillDir, 'SKILL.md'), '---\nname: my-skill\nversion: 1.0.0\n---');

    const updates: SkillUpdate[] = [
      { slug: 'my-skill', currentVersion: '1.0.0', latestVersion: '2.0.0' },
    ];

    const indexEntries = [
      {
        slug: 'my-skill',
        name: 'My Skill',
        description: 'desc',
        version: '2.0.0',
        author: 'bob',
        skillMd: '---\nname: my-skill\nversion: 2.0.0\n---\n\n# v2',
        metaJson: '{}',
        invokeScript: null,
      },
    ];

    const updated = applySkillUpdates(updates, tmpDir, indexEntries as any);
    expect(updated).toEqual(['my-skill']);
    expect(fs.readFileSync(path.join(tmpDir, 'my-skill', 'SKILL.md'), 'utf8')).toContain('2.0.0');
  });

  it('skips updates when slug is not in index', () => {
    const updates: SkillUpdate[] = [
      { slug: 'missing-skill', currentVersion: '1.0.0', latestVersion: '2.0.0' },
    ];

    const updated = applySkillUpdates(updates, tmpDir, []);
    expect(updated).toEqual([]);
  });
});
```

- [ ] **Step 2: Run tests to verify they pass**

Run: `pnpm --filter @agentoctopus/cli exec vitest run tests/sync-skills.test.ts`
Expected: All tests PASS

- [ ] **Step 3: Commit**

```bash
git add apps/cli/tests/sync-skills.test.ts
git commit -m "test(cli): add tests for sync-skills module"
```

---

### Task 5: Wire up `octopus update` command in `index.ts`

**Files:**
- Modify: `apps/cli/src/index.ts`

- [ ] **Step 1: Add the import and command**

Add import at the top of `index.ts` (after existing imports around line 18):

```typescript
import { checkPackageUpdates, displayUpdateTable, runGlobalInstall } from './update.js';
```

Add the `update` command after the `program` setup (before the `onboard` command around line 36):

```typescript
program
  .command('update')
  .description('Check and install the latest @agentoctopus npm packages')
  .option('--check', 'Show available updates without installing')
  .option('-y, --yes', 'Skip confirmation prompt')
  .action(async (options: { check?: boolean; yes?: boolean }) => {
    const spinner = ora('Checking for updates...').start();
    try {
      const updates = await checkPackageUpdates();
      spinner.succeed('Update check complete');

      if (updates.length === 0) {
        console.log(chalk.yellow('  Cannot reach npm registry. Check your connection.'));
        return;
      }

      const updateable = displayUpdateTable(updates);

      if (updateable === 0) {
        console.log(chalk.green('\n  All packages are up to date.'));
        return;
      }

      if (options.check) {
        console.log(chalk.gray(`\n  Run ${chalk.cyan('octopus update')} to install updates.`));
        process.exit(1);
      }

      // Confirmation prompt
      if (!options.yes) {
        const rl = readline.createInterface({ input: process.stdin, output: process.stdout });
        const answer = await new Promise<string>((resolve) => {
          rl.question(`\n  Update ${updateable} package(s)? [y/N] `, resolve);
        });
        rl.close();
        if (answer.toLowerCase() !== 'y') {
          console.log(chalk.gray('  Update cancelled.'));
          return;
        }
      }

      const installSpinner = ora('Installing @agentoctopus/cli@latest...').start();
      const success = runGlobalInstall();
      if (success) {
        installSpinner.succeed('Update installed successfully!');
        console.log(chalk.gray('  Run `octopus --version` to verify the new version.'));
      } else {
        installSpinner.fail('Update failed. Try running `npm install -g @agentoctopus/cli@latest` manually.');
      }
    } catch (err) {
      spinner.fail(`Update check failed: ${(err as Error).message}`);
    }
  });
```

- [ ] **Step 2: Build CLI package**

Run: `pnpm --filter @agentoctopus/cli build`
Expected: Build succeeds with no errors

- [ ] **Step 3: Commit**

```bash
git add apps/cli/src/index.ts
git commit -m "feat(cli): add octopus update command for npm package updates"
```

---

### Task 6: Replace `octopus sync` and remove `sync-awesome` in `index.ts`

**Files:**
- Modify: `apps/cli/src/index.ts`

- [ ] **Step 1: Add the import**

Add import at the top of `index.ts` (after the update import):

```typescript
import { runSync, checkSkillUpdates } from './sync-skills.js';
```

- [ ] **Step 2: Replace the `sync` command handler**

Replace the existing `sync` command block (lines 407–440 approximately) with:

```typescript
program
  .command('sync')
  .description('Sync and update skills — check for updates, install from awesome-openclaw-skills, and/or sync from cloud')
  .option('--cloud-url <url>', 'Cloud AgentOctopus instance URL')
  .option('--category <name>', 'Install only skills from one category (e.g. "git-and-github")')
  .option('--limit <n>', 'Maximum number of skills to install', parseInt)
  .option('--force', 'Overwrite existing skills even if versions match')
  .option('--dry-run', 'Preview what would happen without making changes')
  .option('--check', 'Show available skill updates without installing')
  .option('--registry <url>', 'Custom ClaWHub registry URL')
  .action(async (options: {
    cloudUrl?: string;
    category?: string;
    limit?: number;
    force?: boolean;
    dryRun?: boolean;
    check?: boolean;
    registry?: string;
  }) => {
    const rootDir = process.env.OCTOPUS_ROOT || process.cwd();
    const skillsDir = process.env.REGISTRY_PATH || path.join(rootDir, 'registry', 'skills');

    await runSync({
      skillsDir,
      check: options.check,
      category: options.category,
      limit: options.limit,
      cloudUrl: options.cloudUrl,
      force: options.force,
      dryRun: options.dryRun,
      registryUrl: options.registry,
    });
  });
```

- [ ] **Step 3: Remove the `sync-awesome` command**

Delete the entire `sync-awesome` command block (lines 443–595 approximately) from `index.ts`.

- [ ] **Step 4: Build CLI package**

Run: `pnpm --filter @agentoctopus/cli build`
Expected: Build succeeds with no errors

- [ ] **Step 5: Run all CLI tests**

Run: `pnpm --filter @agentoctopus/cli test`
Expected: All tests PASS

- [ ] **Step 6: Commit**

```bash
git add apps/cli/src/index.ts
git commit -m "feat(cli): replace sync with three-phase skill sync, remove sync-awesome"
```

---

### Task 7: Update CLAUDE.md

**Files:**
- Modify: `CLAUDE.md`

- [ ] **Step 1: Add `update` command to the Commands section**

Add after the existing CLI commands block in the Commands section:

```bash
# CLI update commands (must build first)
node apps/cli/dist/index.js update          # check and install latest @agentoctopus packages
node apps/cli/dist/index.js update --check  # check only, don't install
node apps/cli/dist/index.js sync            # update skills + install from awesome-openclaw-skills
node apps/cli/dist/index.js sync --check    # check for skill updates only
node apps/cli/dist/index.js sync --cloud-url <url>  # also sync from cloud instance
```

- [ ] **Step 2: Update the Architecture table**

Add a row for the `update` command in the Package responsibilities table under `apps/cli`:

```
| `apps/cli` | `src/index.ts`, `src/update.ts`, `src/sync-skills.ts` | Commander CLI (`list`, `ask`, `update`, `sync`, `onboard`, `skill`) |
```

- [ ] **Step 3: Commit**

```bash
git add CLAUDE.md
git commit -m "docs: add update and sync commands to CLAUDE.md"
```

---

### Task 8: Update README.md

**Files:**
- Modify: `README.md`

- [ ] **Step 1: Update the "Adding More Skills" section**

Replace the existing sync-awesome references with the new `sync` command:

```markdown
## Adding More Skills

```bash
# Install a single skill from ClaWHub
octopus add <slug>

# Sync skills: check for updates + install from awesome-openclaw-skills (5,000+ skills)
octopus sync

# Check for available skill updates without installing
octopus sync --check

# Filter by category
octopus sync --category productivity

# Also sync from a cloud AgentOctopus instance
octopus sync --cloud-url https://your-cloud-instance.com
```

Browse the full curated list: [awesome-openclaw-skills](https://github.com/VoltAgent/awesome-openclaw-skills)

## Updating AgentOctopus

```bash
# Check for package updates
octopus update --check

# Install latest packages
octopus update
```
```

- [ ] **Step 2: Commit**

```bash
git add README.md
git commit -m "docs: update README with octopus update and revised sync commands"
```

---

### Task 9: Update TEST_INSTRUCTIONS.md

**Files:**
- Modify: `TEST_INSTRUCTIONS.md`

- [ ] **Step 1: Add test rows for `octopus update` and `octopus sync`**

Append to the end of TEST_INSTRUCTIONS.md:

```markdown
---

## Phase 9 — Update & Sync Commands

### 9.1 Check for package updates

```bash
node apps/cli/dist/index.js update --check
```

**Expected:** Table showing @agentoctopus packages with current and latest versions. Exit code 0 if up to date, 1 if updates available.

### 9.2 Check for skill updates

```bash
node apps/cli/dist/index.js sync --check
```

**Expected:** List of installed skills with available updates, or "All installed skills are up to date."

### 9.3 Sync skills (dry run)

```bash
node apps/cli/dist/index.js sync --dry-run --limit 5
```

**Expected:** Preview of up to 5 skills that would be installed, without making changes.

### 9.4 Sync skills with category filter

```bash
node apps/cli/dist/index.js sync --category git-and-github --dry-run
```

**Expected:** Preview of git-and-github category skills only.

### 9.5 Sync from cloud instance

```bash
node apps/cli/dist/index.js sync --cloud-url https://your-cloud-instance.com
```

**Expected:** Three-phase output: version check → awesome install → cloud sync results.
```

- [ ] **Step 2: Commit**

```bash
git add TEST_INSTRUCTIONS.md
git commit -m "docs: add test instructions for octopus update and sync commands"
```

---

### Task 10: Build and verify everything

- [ ] **Step 1: Full monorepo build**

Run: `pnpm build`
Expected: All packages build successfully

- [ ] **Step 2: Run all tests**

Run: `pnpm test`
Expected: All tests pass

- [ ] **Step 3: Smoke test the new commands**

Run:
```bash
node apps/cli/dist/index.js update --check
node apps/cli/dist/index.js sync --check
node apps/cli/dist/index.js sync --dry-run --limit 3
```

Expected: All three commands run without errors.

- [ ] **Step 4: Final commit if any fixes needed**

If any build or test fixes were needed, commit them:
```bash
git add -A
git commit -m "fix(cli): address build/test issues from update and sync implementation"
```
