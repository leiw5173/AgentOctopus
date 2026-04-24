import chalk from 'chalk';
import { dbg } from '@agentoctopus/core';
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
  debug?: boolean;
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
  debug = false,
): Promise<SkillUpdate[]> {
  const updates: SkillUpdate[] = [];

  // Download the full skills index for version comparison
  let indexEntries: SkillIndexEntry[];
  try {
    dbg(debug, 'Fetching skills index from ClaWHub...');
    const t0 = Date.now();
    indexEntries = await downloadSkillsIndex();
    dbg(debug, `Skills index: ${indexEntries.length} entries received (${Date.now() - t0}ms)`);
  } catch {
    dbg(debug, 'Skills index fetch failed — cannot check versions');
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

  const comparisonRows: Array<{ slug: string; installed: string; available: string; action: string }> = [];

  for (const slug of installedSlugs) {
    const skillMdPath = path.join(skillsDir, slug, 'SKILL.md');
    try {
      const content = fs.readFileSync(skillMdPath, 'utf8');
      const frontmatterMatch = content.match(/^---\n([\s\S]*?)\n---/);
      if (!frontmatterMatch) continue;

      const frontmatter = frontmatterMatch[1]!;
      const versionMatch = frontmatter.match(/^version:\s*['"]?([^'"\n]+)['"]?/m);
      if (!versionMatch) continue;

      const currentVersion = versionMatch[1]!.trim();
      const indexEntry = indexMap.get(slug);

      if (!indexEntry) {
        comparisonRows.push({ slug, installed: currentVersion, available: '(not found)', action: 'SKIP (not in registry)' });
        continue;
      }

      if (indexEntry.version !== currentVersion && indexEntry.version > currentVersion) {
        comparisonRows.push({ slug, installed: currentVersion, available: indexEntry.version, action: 'UPDATE' });
        updates.push({ slug, currentVersion, latestVersion: indexEntry.version });
      } else {
        comparisonRows.push({ slug, installed: currentVersion, available: indexEntry.version, action: 'SKIP (up to date)' });
      }
    } catch {
      // Skip skills with unreadable manifests
    }
  }

  if (debug && comparisonRows.length > 0) {
    dbg(debug, 'Version comparison:');
    dbg(debug, `  ${'skill'.padEnd(22)}${'installed'.padEnd(12)}${'available'.padEnd(14)}action`);
    for (const row of comparisonRows) {
      dbg(debug, `  ${row.slug.padEnd(22)}${row.installed.padEnd(12)}${row.available.padEnd(14)}${row.action}`);
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
    debug?: boolean;
  },
): Promise<AwesomeInstallResult> {
  const debug = options.debug ?? false;
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
    dbg(debug, 'Fetching skills index from ClaWHub (index path)...');
    const t0 = Date.now();
    indexEntries = await downloadSkillsIndex();
    dbg(debug, `Skills index: ${indexEntries.length} entries received (${Date.now() - t0}ms)`);
  } catch {
    dbg(debug, 'Skills index fetch failed — falling back to per-skill fetch');
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
        // Patch missing scripts/files even when the skill already exists locally.
        // installFromIndex's patch path only writes files that are absent,
        // so this is safe to call on every sync without --force.
        installFromIndex(entry, options.skillsDir, false);
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
      dbg(debug, `Installing ${slug} from ClaWHub...`);
      const t0 = Date.now();
      await installSkill(slug, options.skillsDir, {
        registryUrl: options.registryUrl,
        force: options.force,
      });
      dbg(debug, `${slug} installed (${Date.now() - t0}ms)`);
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
    result.updatesAvailable = await checkSkillUpdates(options.skillsDir, options.debug);
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
  console.log(chalk.bold('\n  Syncing awesome skills...'));
  try {
    const awesomeResult = await installAwesomeSkills({
      skillsDir: options.skillsDir,
      category: options.category,
      limit: options.limit,
      force: options.force,
      dryRun: options.dryRun,
      registryUrl: options.registryUrl,
      debug: options.debug,
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
    const msg = options.cloudUrl
      ? `Updated ${totalUpdated} skill(s). Restart the server to pick up changes.`
      : `Updated ${totalUpdated} skill(s).`;
    console.log(chalk.yellow(`\n  ${msg}`));
  }

  return result;
}
