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
import { installSkill, searchSkills, fetchSkillMeta } from './clawhub.js';
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
  .command('start')
  .description('Start the web app and agent gateway together (requires source checkout)')
  .action(async () => {
    // Check if we're in the monorepo (pnpm-workspace.yaml exists)
    const rootDir = process.env.OCTOPUS_ROOT || process.cwd();
    const wsFile = path.join(rootDir, 'pnpm-workspace.yaml');
    const pkgFile = path.join(rootDir, 'package.json');

    if (!fs.existsSync(wsFile) || !fs.existsSync(pkgFile)) {
      console.error(chalk.red('\n  Error: `octopus start` requires the AgentOctopus source repository.\n'));
      console.log(chalk.gray('  This command starts the web UI and gateway from the monorepo.'));
      console.log(chalk.gray('  It cannot run from a global npm install.\n'));
      console.log(chalk.white('  To use from source:'));
      console.log(chalk.cyan('    git clone https://github.com/leiw5173/AgentOctopus.git'));
      console.log(chalk.cyan('    cd AgentOctopus && pnpm install && pnpm build'));
      console.log(chalk.cyan('    octopus start\n'));
      console.log(chalk.white('  Available without source:'));
      console.log(chalk.cyan('    octopus ask "translate hello to French"'));
      console.log(chalk.cyan('    octopus list'));
      console.log(chalk.cyan('    octopus add <skill>'));
      console.log(chalk.cyan('    octopus search <query>\n'));
      process.exitCode = 1;
      return;
    }

    console.log(chalk.bold('\n🐙 Starting AgentOctopus services\n'));
    console.log(chalk.gray('  Web UI + REST API: http://localhost:3000'));
    console.log(chalk.gray('  Agent gateway:     http://localhost:3002/agent/health\n'));

    try {
      await startService(rootDir);
    } catch (error) {
      console.error(chalk.red(`Service startup failed: ${error}`));
      process.exitCode = 1;
    }
  });

/**
 * Helper to bootstrap the core Octopus engine
 */
async function bootstrap() {
  const rootDir = process.env.OCTOPUS_ROOT || process.cwd();
  const skillsDir = process.env.REGISTRY_PATH || path.join(rootDir, 'registry', 'skills');
  const ratingsPath = process.env.RATINGS_PATH || path.join(rootDir, 'registry', 'ratings.json');

  const registry = new SkillRegistry(skillsDir, ratingsPath);
  await registry.load();

  const provider = (process.env.LLM_PROVIDER as 'openai' | 'gemini' | 'ollama') || 'openai';
  const chatConfig: LLMConfig = {
    provider,
    model: process.env.LLM_MODEL || 'gpt-4o',
    apiKey: process.env.OPENAI_API_KEY || process.env.GEMINI_API_KEY,
    baseUrl: provider === 'openai' ? process.env.OPENAI_BASE_URL : process.env.OLLAMA_BASE_URL,
  };

  const embedProvider = (process.env.EMBED_PROVIDER as 'openai' | 'gemini' | 'ollama') || provider;
  const embedConfig: LLMConfig = {
    provider: embedProvider,
    model: process.env.EMBED_MODEL || 'text-embedding-3-small',
    apiKey: process.env.EMBED_API_KEY || chatConfig.apiKey,
    baseUrl: process.env.EMBED_BASE_URL || chatConfig.baseUrl,
  };

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
  .action(async (query: string) => {
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

program.parse();
