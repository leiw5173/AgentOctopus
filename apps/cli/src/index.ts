#!/usr/bin/env node
import { Command } from 'commander';
import chalk from 'chalk';
import ora from 'ora';
import path from 'path';
import fs from 'fs';
import dotenv from 'dotenv';
import readline from 'readline';

import { SkillRegistry, syncFromCloud } from '@agentoctopus/registry';
import { Router, Executor, type LLMConfig } from '@agentoctopus/core';
import { startService } from './service.js';
import { installSkill, searchSkills, fetchSkillMeta, fetchAwesomeSlugs, downloadSkillsIndex, installFromIndex } from './clawhub.js';
import { runOnboarding, ensureOnboarded } from './onboard.js';
import { loadOctopusConfig, saveOctopusConfig, defaultConfig, getConfigPath } from './config.js';
import { runSkillCreateWizard, runSkillTemplate } from './skill-create.js';
import { connectOpenClaw } from './connect.js';
import { fileURLToPath } from 'url';

// Load env
dotenv.config();
dotenv.config({ path: path.join(process.cwd(), '.env') });

// Read version from package.json dynamically
const __cliDir = path.dirname(fileURLToPath(import.meta.url));
const cliPkg = JSON.parse(fs.readFileSync(path.join(__cliDir, '..', 'package.json'), 'utf8'));

const program = new Command();

program
  .name('octopus')
  .description('AgentOctopus CLI — intelligent routing for skills and MCPs')
  .version(cliPkg.version);

program
  .command('onboard')
  .description('Interactive setup wizard — configure LLM, skills, and execution mode')
  .action(async () => {
    try {
      const rootDir = process.env.OCTOPUS_ROOT || process.cwd();
      await runOnboarding(rootDir);
    } catch (err) {
      if ((err as Error).name === 'ExitPromptError') {
        console.log(chalk.gray('\n  Setup cancelled.\n'));
      } else {
        console.error(chalk.red(`Setup failed: ${err}`));
        process.exitCode = 1;
      }
    }
  });

program
  .command('start')
  .description('Start the AgentOctopus gateway server')
  .action(async () => {
    // Auto-trigger onboarding if .env is missing
    const onboarded = await ensureOnboarded();
    if (!onboarded) return;

    const rootDir = process.env.OCTOPUS_ROOT || process.cwd();
    const port = Number(process.env.AGENT_GATEWAY_PORT ?? 3002);

    console.log(chalk.bold('\n🐙 Starting AgentOctopus gateway\n'));
    console.log(chalk.gray(`  Agent gateway: http://localhost:${port}/agent/health`));
    console.log(chalk.gray('  Press Ctrl+C to stop\n'));

    try {
      await startService(rootDir);
    } catch (error) {
      console.error(chalk.red(`Gateway failed: ${error}`));
      process.exitCode = 1;
    }
  });

/**
 * Helper to bootstrap the core Octopus engine
 */
async function bootstrap() {
  const octopusConfig = loadOctopusConfig();

  // Only honour REGISTRY_PATH / RATINGS_PATH when they are absolute paths or
  // actually exist on disk — relative paths from a stale .env (e.g. the
  // ./registry/skills default written by older CLI versions) would otherwise
  // shadow the user-configured octopus.json skillsDir.
  const rawRegistryPath = process.env.REGISTRY_PATH;
  const resolvedRegistryPath = rawRegistryPath ? path.resolve(rawRegistryPath) : undefined;
  const useEnvRegistry = resolvedRegistryPath && fs.existsSync(resolvedRegistryPath);

  const rawRatingsPath = process.env.RATINGS_PATH;
  const resolvedRatingsPath = rawRatingsPath ? path.resolve(rawRatingsPath) : undefined;
  const useEnvRatings = resolvedRatingsPath && fs.existsSync(resolvedRatingsPath);

  const skillsDir =
    (useEnvRegistry ? resolvedRegistryPath : undefined) ||
    octopusConfig?.skillsDir ||
    path.join(process.env.OCTOPUS_ROOT || process.cwd(), 'registry', 'skills');
  const ratingsPath =
    (useEnvRatings ? resolvedRatingsPath : undefined) ||
    octopusConfig?.ratingsPath ||
    path.join(process.env.OCTOPUS_ROOT || process.cwd(), 'registry', 'ratings.json');

  // Merge stored credentials into process.env so scripts/invoke.js can read them
  if (octopusConfig?.credentials) {
    for (const [key, value] of Object.entries(octopusConfig.credentials)) {
      if (!process.env[key]) process.env[key] = value;
    }
  }

  const registry = new SkillRegistry(skillsDir, ratingsPath);
  await registry.load();

  const provider = (process.env.LLM_PROVIDER as 'openai' | 'gemini' | 'ollama') || 'openai';
  const chatConfig: LLMConfig = {
    provider,
    model: process.env.LLM_MODEL || 'gpt-4o',
    apiKey: process.env.OPENAI_API_KEY || process.env.GEMINI_API_KEY,
    baseUrl: provider === 'openai' ? process.env.OPENAI_BASE_URL : process.env.OLLAMA_BASE_URL,
  };

  const embedConfig: LLMConfig | undefined =
    process.env.EMBED_PROVIDER && process.env.EMBED_API_KEY
      ? {
          provider: (process.env.EMBED_PROVIDER as 'openai' | 'gemini' | 'ollama'),
          model: process.env.EMBED_MODEL || 'text-embedding-3-small',
          apiKey: process.env.EMBED_API_KEY,
          baseUrl: process.env.EMBED_BASE_URL || chatConfig.baseUrl,
        }
      : undefined;

  const router = new Router(chatConfig, embedConfig);
  const executor = new Executor(registry);

  return { registry, router, executor };
}

program
  .command('list')
  .description('List all available skills')
  .action(async () => {
    const spinner = ora('Loading registry...').start();
    try {
      const { registry } = await bootstrap();
      const skills = registry.getAll();
      spinner.stop();

      console.log(chalk.bold('\n🐙 AgentOctopus — Available Skills\n'));

      if (skills.length === 0) {
        console.log(chalk.gray('  No skills found in registry.'));
        return;
      }

      skills.sort((a, b) => b.rating - a.rating);

      skills.forEach((s) => {
        const { manifest, rating } = s;
        const stars = '⭐'.repeat(Math.round(rating)) + '☆'.repeat(5 - Math.round(rating));
        console.log(`  ${chalk.cyan.bold(manifest.name)} ${chalk.yellow(stars)} (${rating.toFixed(1)})`);
        console.log(`  ${chalk.gray(manifest.description)}`);
        console.log(`  Adapter: ${manifest.adapter} | Uses: ${manifest.invocations}\n`);
      });
    } catch (err) {
      spinner.fail(`Failed to load registry: ${err}`);
    }
  });

program
  .command('ask <query>')
  .description('Ask AgentOctopus to route your request to the best skill')
  .option('--no-prompt', 'Skip the interactive feedback prompt (for programmatic use)')
  .action(async (query: string, options: { prompt: boolean }) => {
    // Auto-trigger onboarding if .env is missing
    const onboarded = await ensureOnboarded();
    if (!onboarded) return;

    console.log(chalk.bold(`\n🐙 Request: "${query}"\n`));

    const spinner = ora('Loading registry and embedding skills...').start();
    let engine;
    try {
      engine = await bootstrap();
      await engine.router.buildIndex(engine.registry.getAll());
    } catch (err) {
      spinner.fail(`Initialization failed: ${err}`);
      return;
    }

    spinner.text = 'Finding the best skill...';
    const routes = await engine.router.route(query);

    if (routes.length === 0) {
      spinner.fail('No matching skill found for your request.');
      return;
    }

    const { skill, score, reason } = routes[0]!;
    spinner.succeed(`Selected skill: ${chalk.cyan.bold(skill.manifest.name)}`);
    console.log(chalk.gray(`  Reason: ${reason}`));
    console.log(chalk.gray(`  Match Score: ${score.toFixed(3)}\n`));

    spinner.start(`Executing ${skill.manifest.name}...`);
    try {
      // In a real implementation, we'd use an LLM to extract JSON params from the `query`
      // based on the skill's `input_schema`. For MVP, we pass the raw query as the main param.
      const input = { query, text: query };
      
      const result = await engine.executor.execute(skill, input);
      
      if (result.adapterResult.success) {
        spinner.succeed('Execution successful\n');
        console.log(chalk.green('Result:'));
        console.log(result.formattedOutput + '\n');

        // Ask for feedback
        if (options.prompt !== false) {
          const rl = readline.createInterface({
            input: process.stdin,
            output: process.stdout,
          });

          rl.question(chalk.yellow('Was this helpful? (y/n): '), (answer) => {
            const isPositive = answer.toLowerCase() === 'y' || answer.toLowerCase() === 'yes';
            engine.registry.recordFeedback(skill.manifest.name, isPositive);
            console.log(chalk.gray('Thank you for your feedback! Rating updated.'));
            rl.close();
          });
        }
      } else {
        spinner.fail('Execution failed\n');
        console.error(chalk.red('Error:'), result.adapterResult.error);
      }
    } catch (err) {
      spinner.fail('Execution crashed');
      console.error(err);
    }
  });

program
  .command('add <slug>')
  .description('Install a skill from ClaWHub (clawhub.ai)')
  .option('--version <version>', 'Install a specific version')
  .option('--force', 'Overwrite existing skill')
  .option('--registry <url>', 'Custom ClaWHub registry URL')
  .action(async (slug: string, options: { version?: string; force?: boolean; registry?: string }) => {
    const spinner = ora(`Fetching skill "${slug}" from ClaWHub...`).start();
    try {
      const rootDir = process.env.OCTOPUS_ROOT || process.cwd();
      const skillsDir = process.env.REGISTRY_PATH || path.join(rootDir, 'registry', 'skills');

      const meta = await fetchSkillMeta(slug, options.registry);
      spinner.text = `Downloading ${chalk.cyan(meta.name || slug)} v${options.version || meta.version}...`;

      const skillDir = await installSkill(slug, skillsDir, {
        version: options.version,
        registryUrl: options.registry,
        force: options.force,
      });

      spinner.succeed(`Installed ${chalk.cyan.bold(meta.name || slug)} v${options.version || meta.version}`);
      console.log(chalk.gray(`  Path: ${skillDir}`));
      console.log(chalk.gray(`  Author: ${meta.author}`));
      if (meta.stars) console.log(chalk.gray(`  Stars: ${meta.stars}`));
      console.log(chalk.yellow('\n  Restart the server to pick up the new skill.'));
    } catch (err) {
      spinner.fail(`Failed to install "${slug}": ${(err as Error).message}`);
    }
  });

program
  .command('search <query>')
  .description('Search for skills on ClaWHub')
  .option('--registry <url>', 'Custom ClaWHub registry URL')
  .action(async (query: string, options: { registry?: string }) => {
    const spinner = ora(`Searching ClaWHub for "${query}"...`).start();
    try {
      const results = await searchSkills(query, options.registry);
      spinner.stop();

      if (results.length === 0) {
        console.log(chalk.yellow(`\n  No skills found for "${query}".`));
        return;
      }

      console.log(chalk.bold(`\n🐙 ClaWHub — Search Results for "${query}"\n`));
      for (const r of results) {
        console.log(`  ${chalk.cyan.bold(r.slug)} ${chalk.gray(`v${r.version}`)} ${chalk.yellow(`⭐ ${r.stars || 0}`)}`);
        console.log(`  ${chalk.gray(r.description || 'No description')}`);
        console.log(`  ${chalk.gray(`by ${r.author}`)}  →  ${chalk.green(`octopus add ${r.slug}`)}\n`);
      }
    } catch (err) {
      spinner.fail(`Search failed: ${(err as Error).message}`);
    }
  });

program
  .command('remove <name>')
  .description('Remove an installed skill from the local registry')
  .action(async (name: string) => {
    const rootDir = process.env.OCTOPUS_ROOT || process.cwd();
    const skillsDir = process.env.REGISTRY_PATH || path.join(rootDir, 'registry', 'skills');
    const skillDir = path.join(skillsDir, name);

    if (!fs.existsSync(skillDir)) {
      console.log(chalk.red(`  Skill "${name}" not found at ${skillDir}`));
      return;
    }

    fs.rmSync(skillDir, { recursive: true });
    console.log(chalk.green(`  Removed skill "${name}" from ${skillDir}`));
    console.log(chalk.yellow('  Restart the server to apply changes.'));
  });

program
  .command('publish [dir]')
  .description('Publish a skill to the AgentOctopus marketplace')
  .option('--server <url>', 'Marketplace server URL', 'http://localhost:3000')
  .option('--author <name>', 'Author name')
  .action(async (dir: string | undefined, options: { server: string; author?: string }) => {
    const skillDir = dir ? path.resolve(dir) : process.cwd();
    const skillMdPath = path.join(skillDir, 'SKILL.md');

    if (!fs.existsSync(skillMdPath)) {
      console.error(chalk.red(`\n  No SKILL.md found in ${skillDir}`));
      console.log(chalk.gray('  Create a SKILL.md with YAML frontmatter to publish.\n'));
      return;
    }

    const spinner = ora('Reading skill manifest...').start();

    try {
      const content = fs.readFileSync(skillMdPath, 'utf8');

      // Parse frontmatter (simple YAML between --- delimiters)
      const fmMatch = content.match(/^---\n([\s\S]*?)\n---/);
      if (!fmMatch) {
        spinner.fail('SKILL.md must have YAML frontmatter between --- delimiters');
        return;
      }

      const frontmatter: Record<string, any> = {};
      for (const line of fmMatch[1]!.split('\n')) {
        const colonIdx = line.indexOf(':');
        if (colonIdx > 0) {
          const key = line.slice(0, colonIdx).trim();
          let value = line.slice(colonIdx + 1).trim();
          // Handle arrays like [tag1, tag2]
          if (value.startsWith('[') && value.endsWith(']')) {
            frontmatter[key] = value.slice(1, -1).split(',').map((s: string) => s.trim());
          } else {
            frontmatter[key] = value;
          }
        }
      }

      const slug = frontmatter.name || path.basename(skillDir);
      const name = frontmatter.name || slug;
      const description = frontmatter.description || '';
      const tags = frontmatter.tags || [];
      const version = frontmatter.version || '1.0.0';
      const adapter = frontmatter.adapter || 'subprocess';
      const author = options.author || frontmatter.author || 'anonymous';

      spinner.text = `Publishing ${chalk.cyan(name)} to ${options.server}...`;

      const res = await fetch(`${options.server}/api/marketplace`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          slug,
          name,
          description,
          tags,
          version,
          author,
          adapter,
          skillMd: content,
        }),
      });

      const data = await res.json() as { error?: string; skill?: any };

      if (res.ok) {
        spinner.succeed(`Published ${chalk.cyan.bold(name)} v${version} to marketplace`);
        console.log(chalk.gray(`  Slug: ${slug}`));
        console.log(chalk.gray(`  Author: ${author}`));
        console.log(chalk.green(`\n  Users can install with: octopus add ${slug}`));
        console.log(chalk.green(`  Or from the web UI: ${options.server}/marketplace\n`));
      } else {
        spinner.fail(`Publish failed: ${data.error}`);
      }
    } catch (err) {
      spinner.fail(`Publish failed: ${(err as Error).message}`);
    }
  });

program
  .command('sync')
  .description('Sync skills from a cloud AgentOctopus instance')
  .requiredOption('--cloud-url <url>', 'URL of the cloud AgentOctopus instance')
  .option('--force', 'Overwrite existing skills even if versions match')
  .action(async (options: { cloudUrl: string; force?: boolean }) => {
    const spinner = ora(`Syncing skills from ${options.cloudUrl}...`).start();
    try {
      const rootDir = process.env.OCTOPUS_ROOT || process.cwd();
      const skillsDir = process.env.REGISTRY_PATH || path.join(rootDir, 'registry', 'skills');

      const result = await syncFromCloud(options.cloudUrl, skillsDir, options.force);
      spinner.succeed('Sync complete');

      if (result.added.length > 0) {
        console.log(chalk.green(`  Added: ${result.added.join(', ')}`));
      }
      if (result.updated.length > 0) {
        console.log(chalk.cyan(`  Updated: ${result.updated.join(', ')}`));
      }
      if (result.skipped.length > 0) {
        console.log(chalk.gray(`  Skipped: ${result.skipped.join(', ')}`));
      }
      if (result.errors.length > 0) {
        console.log(chalk.red(`  Errors: ${result.errors.join(', ')}`));
      }

      const total = result.added.length + result.updated.length;
      if (total > 0) {
        console.log(chalk.yellow('\n  Restart the server to pick up synced skills.'));
      }
    } catch (err) {
      spinner.fail(`Sync failed: ${(err as Error).message}`);
    }
  });

program
  .command('sync-awesome')
  .description('Bulk-install skills from the curated awesome-openclaw-skills list (github.com/VoltAgent/awesome-openclaw-skills)')
  .option('--category <name>', 'Install only skills from one category (e.g. "git-and-github")')
  .option('--limit <n>', 'Maximum number of skills to install (useful for testing)', parseInt)
  .option('--force', 'Overwrite already-installed skills')
  .option('--dry-run', 'Preview slugs that would be installed without installing anything')
  .option('--registry <url>', 'Custom ClaWHub registry URL')
  .action(async (options: {
    category?: string;
    limit?: number;
    force?: boolean;
    dryRun?: boolean;
    registry?: string;
  }) => {
    const rootDir = process.env.OCTOPUS_ROOT || process.cwd();
    const skillsDir = process.env.REGISTRY_PATH || path.join(rootDir, 'registry', 'skills');

    const spinner = ora(
      options.category
        ? `Fetching "${options.category}" skill list...`
        : 'Downloading skills index...',
    ).start();

    // ── Step 1: resolve slug filter for --category ──
    let slugFilter: Set<string> | null = null;
    if (options.category) {
      try {
        const categorySlugs = await fetchAwesomeSlugs({ category: options.category });
        slugFilter = new Set(categorySlugs);
      } catch (err) {
        spinner.fail(`Failed to fetch category "${options.category}": ${(err as Error).message}`);
        return;
      }
    }

    // ── Step 2: try index-first path ──
    let indexEntries: import('./clawhub.js').SkillIndexEntry[] | null = null;
    try {
      spinner.text = 'Downloading skills index (one request)...';
      indexEntries = await downloadSkillsIndex();
    } catch (err) {
      spinner.warn(`Skills index unavailable (${(err as Error).message}) — falling back to ClaWHub per-skill fetch.`);
    }

    if (indexEntries !== null) {
      // ── Index path ──
      let entries = indexEntries;
      if (slugFilter) {
        entries = entries.filter(e => slugFilter!.has(e.slug));
      }
      const total = options.limit && options.limit > 0 ? Math.min(options.limit, entries.length) : entries.length;
      entries = entries.slice(0, total);

      spinner.succeed(
        `Found ${entries.length} skill(s)${options.category ? ` in "${options.category}"` : ''} in index.`,
      );

      if (options.dryRun) {
        console.log(chalk.bold('\n  Dry run — skills that would be installed:\n'));
        entries.forEach(e => console.log(`  ${chalk.cyan(e.slug)}`));
        console.log(chalk.gray(`\n  Total: ${entries.length}`));
        return;
      }

      const results = { installed: 0, skipped: 0 };
      for (let i = 0; i < entries.length; i++) {
        const entry = entries[i]!;
        const prefix = chalk.gray(`[${i + 1}/${entries.length}]`);
        const alreadyExists = fs.existsSync(path.join(skillsDir, entry.slug));
        if (alreadyExists && !options.force) {
          console.log(`${prefix} ${chalk.gray('–')} ${entry.slug} ${chalk.gray('(already installed, use --force to overwrite)')}`);
          results.skipped++;
        } else {
          installFromIndex(entry, skillsDir, options.force);
          console.log(`${prefix} ${chalk.green('✔')} ${chalk.cyan(entry.slug)}`);
          results.installed++;
        }
      }

      console.log(
        chalk.bold(`\n  Done. Installed: ${results.installed}  Skipped: ${results.skipped}`),
      );
      if (results.installed > 0) {
        console.log(chalk.yellow('\n  Restart the server to pick up new skills.'));
      }
      return;
    }

    // ── Fallback: per-skill ClaWHub fetch (original behaviour) ──
    let slugs: string[];
    try {
      spinner.text = options.category
        ? `Fetching "${options.category}" skills from awesome-openclaw-skills...`
        : 'Fetching skill list from awesome-openclaw-skills...';
      slugs = slugFilter ? Array.from(slugFilter) : await fetchAwesomeSlugs();
    } catch (err) {
      spinner.fail(`Failed to fetch skill list: ${(err as Error).message}`);
      return;
    }

    const total = options.limit && options.limit > 0 ? Math.min(options.limit, slugs.length) : slugs.length;
    slugs = slugs.slice(0, total);

    spinner.succeed(
      `Found ${slugs.length} skill(s)${options.category ? ` in "${options.category}"` : ''}.`,
    );

    if (options.dryRun) {
      console.log(chalk.bold('\n  Dry run — skills that would be installed:\n'));
      slugs.forEach(s => console.log(`  ${chalk.cyan(s)}`));
      console.log(chalk.gray(`\n  Total: ${slugs.length}`));
      return;
    }

    const results = { installed: 0, skipped: 0, failed: 0 };
    const failedSlugs: string[] = [];

    for (let i = 0; i < slugs.length; i++) {
      const slug = slugs[i]!;
      const prefix = chalk.gray(`[${i + 1}/${slugs.length}]`);
      try {
        await installSkill(slug, skillsDir, { registryUrl: options.registry, force: options.force });
        console.log(`${prefix} ${chalk.green('✔')} ${chalk.cyan(slug)}`);
        results.installed++;
      } catch (err) {
        const msg = (err as Error).message ?? '';
        if (msg.includes('already exists')) {
          console.log(`${prefix} ${chalk.gray('–')} ${slug} ${chalk.gray('(already installed, use --force to overwrite)')}`);
          results.skipped++;
        } else {
          console.log(`${prefix} ${chalk.red('✘')} ${slug} — ${chalk.red(msg)}`);
          failedSlugs.push(slug);
          results.failed++;
        }
      }
    }

    console.log(
      chalk.bold(
        `\n  Done. Installed: ${results.installed}  Skipped: ${results.skipped}  Failed: ${results.failed}`,
      ),
    );
    if (failedSlugs.length > 0) {
      console.log(chalk.red(`  Failed: ${failedSlugs.join(', ')}`));
    }
    if (results.installed > 0) {
      console.log(chalk.yellow('\n  Restart the server to pick up new skills.'));
    }
  });

// ── octopus skill <subcommand> ─────────────────────────────────────────────
const skillCmd = program
  .command('skill')
  .description('Manage skills — create, install, remove, search, publish, list');

skillCmd
  .command('create')
  .description('Create a new skill with AI assistance (or use --template for a blank scaffold)')
  .option('--template', 'Skip AI and write a blank scaffold instead')
  .action(async (options: { template?: boolean }) => {
    if (options.template) {
      await runSkillTemplate();
    } else {
      const onboarded = await ensureOnboarded();
      if (!onboarded) return;
      await runSkillCreateWizard();
    }
  });

skillCmd
  .command('list')
  .description('List all available skills')
  .action(async () => {
    await program.parseAsync(['', '', 'list'], { from: 'user' });
  });

skillCmd
  .command('add <slug>')
  .description('Install a skill from ClaWHub (clawhub.ai)')
  .option('--version <version>', 'Install a specific version')
  .option('--force', 'Overwrite existing skill')
  .option('--registry <url>', 'Custom ClaWHub registry URL')
  .action(async (slug: string, options: { version?: string; force?: boolean; registry?: string }) => {
    const args = ['', '', 'add', slug];
    if (options.version) args.push('--version', options.version);
    if (options.force) args.push('--force');
    if (options.registry) args.push('--registry', options.registry);
    await program.parseAsync(args, { from: 'user' });
  });

skillCmd
  .command('remove <name>')
  .description('Remove an installed skill')
  .action(async (name: string) => {
    await program.parseAsync(['', '', 'remove', name], { from: 'user' });
  });

skillCmd
  .command('search <query>')
  .description('Search for skills on ClaWHub')
  .option('--registry <url>', 'Custom ClaWHub registry URL')
  .action(async (query: string, options: { registry?: string }) => {
    const args = ['', '', 'search', query];
    if (options.registry) args.push('--registry', options.registry);
    await program.parseAsync(args, { from: 'user' });
  });

skillCmd
  .command('publish [dir]')
  .description('Publish a skill to the marketplace')
  .option('--server <url>', 'Marketplace server URL', 'http://localhost:3000')
  .option('--author <name>', 'Author name')
  .action(async (dir: string | undefined, options: { server: string; author?: string }) => {
    const args = ['', '', 'publish'];
    if (dir) args.push(dir);
    args.push('--server', options.server);
    if (options.author) args.push('--author', options.author);
    await program.parseAsync(args, { from: 'user' });
  });

// ── octopus connect <target> ──────────────────────────────────────────────
program
  .command('connect <target>')
  .description('Import LLM configuration from another AI tool (e.g. openclaw)')
  .action(async (target: string) => {
    if (target === 'openclaw') {
      await connectOpenClaw();
    } else {
      console.error(chalk.red(`\n  Unknown connect target: "${target}"`));
      console.error(chalk.gray('  Supported targets: openclaw\n'));
      process.exitCode = 1;
    }
  });

// ── octopus config ────────────────────────────────────────────────────────────
const configCmd = program
  .command('config')
  .description('Manage AgentOctopus credential configuration');

configCmd
  .command('set <key> <value>')
  .description('Save a credential or config value (written to ~/.agentoctopus/octopus.json and exported into the current session)')
  .action((key: string, value: string) => {
    const existing = loadOctopusConfig();
    const config = existing ?? defaultConfig();
    config.credentials = config.credentials ?? {};
    config.credentials[key] = value;
    saveOctopusConfig(config);
    // Export into the current process so follow-up commands in the same session see it
    process.env[key] = value;
    console.log(chalk.green(`  ✔ ${key} saved to ${getConfigPath()}`));
  });

configCmd
  .command('list')
  .description('List all stored credentials (values masked)')
  .action(() => {
    const config = loadOctopusConfig();
    const creds = config?.credentials ?? {};
    const keys = Object.keys(creds);

    console.log(chalk.bold('\n🐙 AgentOctopus — Stored Credentials\n'));

    if (keys.length === 0) {
      console.log(chalk.gray('  No credentials stored yet.'));
      console.log(chalk.gray('  Use: octopus config set <KEY> <value>\n'));
      return;
    }

    for (const k of keys) {
      const raw = creds[k] ?? '';
      const masked =
        raw.length > 4
          ? '***' + raw.slice(-4)
          : '****';
      console.log(`  ${chalk.cyan(k)} = ${chalk.gray(masked)}`);
    }
    console.log();
  });

program.parse();
