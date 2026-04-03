import { input, select, confirm } from '@inquirer/prompts';
import chalk from 'chalk';
import fs from 'fs';
import path from 'path';
import { loadOctopusConfig } from './config.js';

// ── Template scaffold ─────────────────────────────────────────────────────────

const SKILL_MD_TEMPLATE = `---
name: my-skill
description: Describe what this skill does.
tags: [example]
version: 1.0.0
adapter: subprocess
hosting: local
auth: none
input_schema:
  query: string
output_schema:
  result: string
---

## Instructions

Describe how the skill should behave. The router uses this text to decide
when to invoke the skill.
`;

const INVOKE_JS_TEMPLATE = `#!/usr/bin/env node
// TODO: implement your skill logic here
const input = JSON.parse(process.env.OCTOPUS_INPUT || '{}');
const { query } = input;

// Example: fetch from an external API
// const res = await fetch(\`https://api.example.com?q=\${query}\`);
// const data = await res.json();

console.log(JSON.stringify({ result: 'TODO' }));
`;

// ── LLM prompt ────────────────────────────────────────────────────────────────

function buildLLMSystemPrompt(): string {
  return `You are generating a SKILL.md file for AgentOctopus.

A SKILL.md file has YAML frontmatter followed by a markdown instructions block.
Return ONLY the SKILL.md content, no explanation, no markdown code fences.`;
}

function buildLLMUserPrompt(answers: {
  description: string;
  type: 'api' | 'llm';
  endpoint?: string;
  authType?: string;
  sampleIO?: string;
  constraints?: string;
}): string {
  const apiSection = answers.type === 'api'
    ? `The skill calls an external API.
Endpoint: ${answers.endpoint || 'not specified'}
Auth: ${answers.authType || 'none'}
Sample input/output: ${answers.sampleIO || 'not provided'}`
    : `The skill is LLM-only (no external API calls).
Constraints/tone: ${answers.constraints || 'none specified'}`;

  return `User description: ${answers.description}
${apiSection}

Generate a valid SKILL.md with this exact structure:
---
name: <slug, lowercase, hyphens>
description: <one sentence, what it does and when to use it>
tags: [<3-5 relevant tags>]
version: 1.0.0
adapter: ${answers.type === 'api' ? 'subprocess' : 'http'}
hosting: local
auth: ${answers.authType === 'none' || answers.type === 'llm' ? 'none' : answers.authType || 'none'}
llm_powered: ${answers.type === 'llm' ? 'true' : 'false'}
input_schema:
  query: string
output_schema:
  result: string
---

## Instructions

<2-4 sentences describing the behavior, how to extract input, and what to return>`;
}

// ── Helpers ───────────────────────────────────────────────────────────────────

function resolveSkillsDir(): string {
  if (process.env.REGISTRY_PATH) return process.env.REGISTRY_PATH;
  const config = loadOctopusConfig();
  if (config?.skillsDir) return config.skillsDir;
  return path.join(process.cwd(), 'registry', 'skills');
}

function writeSkillFiles(skillDir: string, skillMd: string, writeScript: boolean): void {
  fs.mkdirSync(skillDir, { recursive: true });
  fs.writeFileSync(path.join(skillDir, 'SKILL.md'), skillMd, 'utf8');

  if (writeScript) {
    const scriptsDir = path.join(skillDir, 'scripts');
    fs.mkdirSync(scriptsDir, { recursive: true });
    const invokeJs = path.join(scriptsDir, 'invoke.js');
    if (!fs.existsSync(invokeJs)) {
      fs.writeFileSync(invokeJs, INVOKE_JS_TEMPLATE, 'utf8');
    }
  }
}

function extractSkillName(skillMd: string): string {
  const match = skillMd.match(/^---[\s\S]*?^name:\s*(.+)$/m);
  return match ? match[1]!.trim() : 'my-skill';
}

// ── Template mode ─────────────────────────────────────────────────────────────

export async function runSkillTemplate(skillsDir?: string): Promise<void> {
  const targetDir = skillsDir ?? resolveSkillsDir();
  const skillName = 'my-skill';
  const skillDir = path.join(targetDir, skillName);

  if (fs.existsSync(skillDir)) {
    console.log(chalk.red(`\n  Directory already exists: ${skillDir}`));
    console.log(chalk.gray('  Choose a different name or remove the existing skill.\n'));
    return;
  }

  writeSkillFiles(skillDir, SKILL_MD_TEMPLATE, true);

  console.log(chalk.green(`\n  Scaffolded skill at ${skillDir}`));
  console.log(chalk.gray('  Edit SKILL.md to define your skill, then restart the server.\n'));
}

// ── AI wizard mode ────────────────────────────────────────────────────────────

export async function runSkillCreateWizard(skillsDir?: string): Promise<void> {
  const targetDir = skillsDir ?? resolveSkillsDir();

  console.log(chalk.bold('\n  Skill Create Wizard\n'));

  const description = await input({
    message: 'What does your skill do?',
    validate: (v) => (v.trim().length > 0 ? true : 'Description is required'),
  });

  const skillType = await select<'api' | 'llm'>({
    message: 'How does it work?',
    choices: [
      { value: 'api', name: 'Calls an external API' },
      { value: 'llm', name: 'LLM-only (no external calls)' },
    ],
  });

  const answers: Parameters<typeof buildLLMUserPrompt>[0] = { description, type: skillType };

  if (skillType === 'api') {
    answers.endpoint = await input({ message: 'API endpoint URL (optional, press Enter to skip):' });
    answers.authType = await select({
      message: 'Authentication type:',
      choices: [
        { value: 'none', name: 'None' },
        { value: 'api_key', name: 'API key' },
        { value: 'bearer', name: 'Bearer token' },
        { value: 'oauth', name: 'OAuth' },
      ],
    });
    answers.sampleIO = await input({ message: 'Describe a sample input and expected output (optional):' });
  } else {
    answers.constraints = await input({ message: 'Any constraints, tone, or output format? (optional):' });
  }

  // AI generation — use createChatClient from @agentoctopus/core
  // ChatClient has a .chat(systemPrompt, userMessage) method
  let llmChat: (systemPrompt: string, userMessage: string) => Promise<string>;
  try {
    const { createChatClient } = await import('@agentoctopus/core');
    const llmProvider = (process.env.LLM_PROVIDER as 'openai' | 'gemini' | 'ollama') || 'openai';
    const llmConfig = {
      provider: llmProvider,
      model: process.env.LLM_MODEL || 'gpt-4o-mini',
      apiKey: process.env.OPENAI_API_KEY || process.env.GEMINI_API_KEY,
      baseUrl: llmProvider === 'openai' ? process.env.OPENAI_BASE_URL : process.env.OLLAMA_BASE_URL,
    };
    const chatClient = createChatClient(llmConfig);
    llmChat = (systemPrompt, userMessage) => chatClient.chat(systemPrompt, userMessage);
  } catch {
    console.error(chalk.red('  Could not initialize LLM client. Falling back to template.'));
    await runSkillTemplate(targetDir);
    return;
  }

  console.log(chalk.gray('\n  Generating SKILL.md with AI...\n'));

  let skillMd = '';
  let additionalNotes = '';

  while (true) {
    const systemPrompt = buildLLMSystemPrompt();
    const userPrompt = buildLLMUserPrompt(answers) +
      (additionalNotes ? `\n\nAdditional notes: ${additionalNotes}` : '');
    try {
      skillMd = await llmChat(systemPrompt, userPrompt);
    } catch (err) {
      console.error(chalk.red(`  AI generation failed: ${(err as Error).message}`));
      console.log(chalk.gray('  Falling back to template scaffold.\n'));
      await runSkillTemplate(targetDir);
      return;
    }

    console.log(chalk.cyan('─── Generated SKILL.md ───────────────────────────────────────'));
    console.log(skillMd);
    console.log(chalk.cyan('──────────────────────────────────────────────────────────────\n'));

    const action = await select({
      message: 'Does this look right?',
      choices: [
        { value: 'yes', name: 'Yes — write the files' },
        { value: 'regenerate', name: 'Regenerate — add notes for the AI' },
        { value: 'template', name: 'Use template instead (skip AI)' },
      ],
    });

    if (action === 'yes') break;
    if (action === 'template') {
      await runSkillTemplate(targetDir);
      return;
    }
    additionalNotes = await input({ message: 'Notes for the AI (what to change):' });
  }

  const skillName = extractSkillName(skillMd);
  const skillDir = path.join(targetDir, skillName);

  if (fs.existsSync(skillDir)) {
    const overwrite = await confirm({
      message: `Skill directory "${skillDir}" already exists. Overwrite?`,
      default: false,
    });
    if (!overwrite) {
      console.log(chalk.gray('\n  Cancelled. No files written.\n'));
      return;
    }
  }

  writeSkillFiles(skillDir, skillMd, skillType === 'api');

  console.log(chalk.green(`\n  Skill written to ${skillDir}`));
  if (skillType === 'api') {
    console.log(chalk.gray('  Edit scripts/invoke.js to implement the API call.'));
  }
  console.log(chalk.yellow('  Restart the server to pick up the new skill.\n'));
}
