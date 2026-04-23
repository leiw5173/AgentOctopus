#!/usr/bin/env node
import { Command } from 'commander';
import chalk from 'chalk';
import ora from 'ora';
import path from 'path';
import fs from 'fs';
import dotenv from 'dotenv';
import readline from 'readline';

import { SkillRegistry } from '@agentoctopus/registry';
import { Router, Executor, createChatClient, dbg, type LLMConfig, type CredentialMissingResult } from '@agentoctopus/core';
import { startService } from './service.js';
import { installSkill, searchSkills, fetchSkillMeta } from './clawhub.js';
import { runOnboarding, ensureOnboarded } from './onboard.js';
import { loadOctopusConfig, saveOctopusConfig, defaultConfig, getConfigPath, getDefaultSkillsDir, getDefaultRatingsPath } from './config.js';
import { runSkillCreateWizard, runSkillTemplate } from './skill-create.js';
import { connectOpenClaw } from './connect.js';
import { checkPackageUpdates, displayUpdateTable, runGlobalInstall } from './update.js';
import { runSync } from './sync-skills.js';
import { runRatingSync } from './rating-sync.js';
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
        const allCurrent = updates.every((u) => u.current !== null && u.current === u.latest);
        if (allCurrent) {
          console.log(chalk.green('\n  All packages are up to date.'));
        } else {
          console.log(chalk.green('\n  No updates available.'));
        }
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
async function promptSelect(question: string, choices: { label: string; value: string }[]): Promise<string> {
  const rl = readline.createInterface({ input: process.stdin, output: process.stdout });

  console.log(chalk.bold(`\n${question}`));
  choices.forEach((c, i) => console.log(`  ${chalk.cyan(`${i + 1}.`)} ${c.label}`));

  return new Promise((resolve) => {
    rl.question(chalk.gray('> '), (answer) => {
      rl.close();
      const idx = parseInt(answer.trim(), 10) - 1;
      if (idx >= 0 && idx < choices.length) {
        resolve(choices[idx].value);
      } else {
        // Default to first choice on invalid input
        console.log(chalk.yellow(`Invalid choice, defaulting to: ${choices[0].label}`));
        resolve(choices[0].value);
      }
    });
  });
}

async function bootstrap() {
  const octopusConfig = loadOctopusConfig();

  // Canonical skill/rating paths: ~/.agentoctopus/skills and ~/.agentoctopus/ratings.json
  // These are always used unless octopus.json explicitly overrides them.
  const skillsDir = octopusConfig?.skillsDir || getDefaultSkillsDir();
  const ratingsPath = octopusConfig?.ratingsPath || getDefaultRatingsPath();

  // Merge stored credentials into process.env so scripts/invoke.js can read them.
  // octopus.json credentials take priority over any .env file loaded from CWD,
  // since the .env may belong to a different project (e.g. ~/.openclaw/.env).
  if (octopusConfig?.credentials) {
    for (const [key, value] of Object.entries(octopusConfig.credentials)) {
      process.env[key] = value;
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
  const chatClient = createChatClient(chatConfig);
  const executor = new Executor(registry, chatClient);

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
  .option('--debug', 'Show routing and execution internals')
  .action(async (query: string, options: { prompt: boolean; debug?: boolean }) => {
    // Auto-trigger onboarding if .env is missing
    const onboarded = await ensureOnboarded();
    if (!onboarded) return;

    console.log(chalk.bold(`\n🐙 Request: "${query}"\n`));

    const t0 = Date.now();
    const spinner = ora('Loading registry and embedding skills...').start();
    let engine;
    try {
      engine = await bootstrap();
      await engine.router.buildIndex(engine.registry.getAll(), { debug: !!options.debug });
    } catch (err) {
      spinner.fail(`Initialization failed: ${err}`);
      return;
    }
    const t1 = Date.now();

    spinner.text = 'Finding the best skill...';
    const routes = await engine.router.route(query, 20, { debug: !!options.debug });
    const t2 = Date.now();

    if (routes.length === 0) {
      spinner.fail('No matching skill found for your request.');
      if (options.debug) {
        dbg(true, `Timing: init=${t1 - t0}ms  route=${t2 - t1}ms`);
      } else if (process.env.OCTOPUS_TIMING) {
        console.log(chalk.gray(`  Timing: init=${t1 - t0}ms  route=${t2 - t1}ms`));
      }
      return;
    }

    // Determine max retries from config
    const config = loadOctopusConfig();
    const maxRetries = config?.maxRetries ?? 3;
    const candidates = routes.slice(0, maxRetries);
    const input = { query, text: query };

    let succeeded = false;
    const failedResults: Array<{ authGuidance?: string }> = [];
    for (let i = 0; i < candidates.length; i++) {
      const { skill, score, reason } = candidates[i]!;
      const attemptLabel = candidates.length > 1 ? ` (attempt ${i + 1}/${candidates.length})` : '';
      spinner.succeed(`Selected skill: ${chalk.cyan.bold(skill.manifest.name)}${attemptLabel}`);
      console.log(chalk.gray(`  Reason: ${reason}`));
      console.log(chalk.gray(`  Match Score: ${score.toFixed(3)}\n`));

      spinner.start(`Executing ${skill.manifest.name}...`);
      try {
        const result = await engine.executor.execute(skill, input, { debug: !!options.debug });
        const t3 = Date.now();

        if (options.debug) {
          dbg(true, `Timing: init=${t1 - t0}ms  route=${t2 - t1}ms  execute=${t3 - t2}ms  total=${t3 - t0}ms`);
        } else if (process.env.OCTOPUS_TIMING) {
          console.log(chalk.gray(`  Timing: init=${t1 - t0}ms  route=${t2 - t1}ms  execute=${t3 - t2}ms  total=${t3 - t0}ms`));
        }

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

        if ('type' in result && result.type === 'binary_missing') {
          const tools = (result.missing as string[]).map(b => `  • ${b}`).join('\n');
          spinner.fail(`${result.skillName} requires missing tools`);
          console.error(chalk.red(`\nMissing binaries:\n${tools}\n`));
          console.error(chalk.yellow(`  Install the tool(s) above, then retry.`));
          if (i < candidates.length - 1) {
            console.log(chalk.yellow(`\n↻ Trying next skill...\n`));
          }
          continue;
        }

        const execResult = result as import('@agentoctopus/core').ExecutionResult;

        if (execResult.adapterResult.success) {
          succeeded = true;
          spinner.succeed('Execution successful\n');
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

        // Execution failed
        spinner.fail(`${skill.manifest.name} execution failed\n`);
        console.error(chalk.red('Error:'), execResult.adapterResult.error);
        failedResults.push({ authGuidance: execResult.authGuidance });
        if (i < candidates.length - 1) {
          console.log(chalk.yellow(`\n↻ Trying next skill...\n`));
        }
      } catch (err) {
        spinner.fail(`${skill.manifest.name} execution failed`);
        const message = err instanceof Error ? err.message : String(err);
        console.error(chalk.red(message));
        if (i < candidates.length - 1) {
          console.log(chalk.yellow(`\n↻ Trying next skill...\n`));
        }
      }
    }

    if (!succeeded && candidates.length > 0) {
      console.log(chalk.yellow(`\nAll ${candidates.length} skill(s) failed for this request.`));
      const authGuidance = failedResults.find(r => r.authGuidance)?.authGuidance;
      if (authGuidance) {
        console.log('\n' + authGuidance);
      }
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
      const skillsDir = getDefaultSkillsDir();

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
    const skillsDir = getDefaultSkillsDir();
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
  .description('Sync skills and/or ratings — prompts for choice when run without flags')
  .option('--cloud-url <url>', 'Cloud AgentOctopus instance URL')
  .option('--category <name>', 'Install only skills from one category (e.g. "git-and-github")')
  .option('--limit <n>', 'Maximum number of skills to install', parseInt)
  .option('--force', 'Overwrite existing skills even if versions match')
  .option('--dry-run', 'Preview what would happen without making changes')
  .option('--check', 'Show available skill updates without installing')
  .option('--registry <url>', 'Custom ClaWHub registry URL')
  .option('--ratings', 'Sync ratings with GitHub Gist')
  .option('--setup-gist', 'Create or find GitHub Gist for rating sync')
  .option('--pull', 'Pull ratings from cloud to local')
  .option('--push', 'Push local ratings to cloud')
  .option('--no-feedback-sharing', 'Don\'t share feedback comments in sync')
  .option('--debug', 'Show HTTP traces and version comparison details')
  .action(async (options: {
    cloudUrl?: string;
    category?: string;
    limit?: number;
    force?: boolean;
    dryRun?: boolean;
    check?: boolean;
    registry?: string;
    ratings?: boolean;
    setupGist?: boolean;
    pull?: boolean;
    push?: boolean;
    noFeedbackSharing?: boolean;
    debug?: boolean;
  }) => {
    // If --ratings or --setup-gist explicitly passed, run rating sync directly
    if (options.ratings || options.setupGist) {
      await runRatingSync({
        pull: options.pull,
        push: options.push,
        force: options.force,
        dryRun: options.dryRun,
        setupGist: options.setupGist,
        noFeedbackSharing: options.noFeedbackSharing,
      });
      return;
    }

    // If --pull or --push passed without --ratings, treat as --ratings shorthand
    if (options.pull || options.push) {
      await runRatingSync({
        pull: options.pull,
        push: options.push,
        force: options.force,
        dryRun: options.dryRun,
        noFeedbackSharing: options.noFeedbackSharing,
      });
      return;
    }

    // If --check or other skill-specific flags passed, run skills sync directly
    const hasSkillFlags = options.check || options.cloudUrl || options.category || options.limit || options.registry;
    if (hasSkillFlags) {
      const skillsDir = getDefaultSkillsDir();
      await runSync({
        skillsDir,
        check: options.check,
        category: options.category,
        limit: options.limit,
        cloudUrl: options.cloudUrl,
        force: options.force,
        dryRun: options.dryRun,
        registryUrl: options.registry,
        debug: options.debug,
      });
      return;
    }

    // No specific flags — interactive mode: ask what to sync
    const syncChoice = await promptSelect(
      'What would you like to sync?',
      [
        { label: 'Skills', value: 'skills' },
        { label: 'Ratings', value: 'ratings' },
        { label: 'Both (skills + ratings)', value: 'both' },
      ],
    );

    if (syncChoice === 'skills' || syncChoice === 'both') {
      const skillsDir = getDefaultSkillsDir();
      await runSync({
        skillsDir,
        force: options.force,
        dryRun: options.dryRun,
        debug: options.debug,
      });
    }

    if (syncChoice === 'ratings' || syncChoice === 'both') {
      const ratingDirection = await promptSelect(
        'Rating sync direction?',
        [
          { label: 'Pull (cloud → local)', value: 'pull' },
          { label: 'Push (local → cloud)', value: 'push' },
          { label: 'Both (pull + push)', value: 'both' },
        ],
      );
      await runRatingSync({
        pull: ratingDirection === 'pull' || ratingDirection === 'both',
        push: ratingDirection === 'push' || ratingDirection === 'both',
        force: options.force,
        dryRun: options.dryRun,
        noFeedbackSharing: options.noFeedbackSharing,
      });
    }
  });

program

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
