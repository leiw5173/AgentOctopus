#!/usr/bin/env node
import { Command } from 'commander';
import chalk from 'chalk';
import ora from 'ora';
import path from 'path';
import fs from 'fs';
import dotenv from 'dotenv';
import readline from 'readline';

import { SkillRegistry } from '@octopus/registry';
import { Router, Executor, type LLMConfig } from '@octopus/core';

// Load env
dotenv.config();
dotenv.config({ path: path.join(process.cwd(), '.env') });

const program = new Command();

program
  .name('octopus')
  .description('AgentOctopus CLI — intelligent routing for skills and MCPs')
  .version('0.1.0');

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

program.parse();
