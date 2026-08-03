import { input, select, confirm, checkbox, password } from '@inquirer/prompts';
import chalk from 'chalk';
import path from 'path';
import fs from 'fs';
import { fileURLToPath } from 'url';
import { saveConfigFile, saveEnvFile, getConfigPath, getEnvPath, getConfigDir, type OctopusConfigV2 } from '@agentoctopus/core';

// ─── Types ───────────────────────────────────────────────────────────────────

interface AgentOnboardConfig {
  id: string;
  name: string;
  dmPolicy: 'pairing' | 'open';
  sandboxEnabled: boolean;
  // Mirrors the canonical SandboxConfigSchema.defaultBackend enum
  // (packages/sandbox/src/schema.ts) — feat/sandbox removed 'openshell';
  // restricted local execution is now opt-in 'os' + minIsolationLevel.
  sandboxBackend: 'auto' | 'docker' | 'os' | 'vm' | 'ssh' | 'none';
}

interface OnboardConfig {
  llmProvider: 'openai' | 'gemini' | 'ollama';
  llmModel: string;
  openaiApiKey?: string;
  openaiBaseUrl?: string;
  geminiApiKey?: string;
  ollamaBaseUrl?: string;
  ollamaModel?: string;
  embedSameProvider: boolean;
  embedProvider?: 'openai' | 'gemini' | 'ollama';
  embedModel?: string;
  embedApiKey?: string;
  embedBaseUrl?: string;
  rerankModel?: string;
  executionMode: 'local' | 'cloud' | 'hybrid';
  cloudApiKey?: string;
  cloudGatewayUrl?: string;
  disabledSkills: string[];
  enableEvolution: boolean;
  agents: AgentOnboardConfig[];
  sandboxDefaultBackend: 'auto' | 'docker' | 'os' | 'vm' | 'ssh' | 'none';
  enableSlack: boolean;
  enableDiscord: boolean;
  enableTelegram: boolean;
  enableWebhook: boolean;
}

interface DiscoveredSkill {
  name: string;
  description: string;
  credentials: Array<{ key: string; label: string; required: boolean }>;
}

// ─── Helpers ─────────────────────────────────────────────────────────────────

function printBanner() {
  console.log('');
  console.log(chalk.cyan.bold('  ╔══════════════════════════════════════════════════════╗'));
  console.log(chalk.cyan.bold('  ║') + chalk.white.bold('        🐙  AgentOctopus  — Setup Wizard             ') + chalk.cyan.bold('║'));
  console.log(chalk.cyan.bold('  ╚══════════════════════════════════════════════════════╝'));
  console.log('');
  console.log(chalk.gray('  This wizard will help you configure AgentOctopus.'));
  console.log(chalk.gray('  You can re-run it anytime with: ') + chalk.yellow('octopus onboard'));
  console.log('');
}

function printStep(step: number, total: number, title: string) {
  console.log('');
  console.log(chalk.cyan(`  ── Step ${step}/${total}: ${title} ─────────────────────────`));
  console.log('');
}

function discoverSkills(skillsDir: string): DiscoveredSkill[] {
  if (!fs.existsSync(skillsDir)) return [];

  const skills: DiscoveredSkill[] = [];

  for (const entry of fs.readdirSync(skillsDir, { withFileTypes: true })) {
    if (!entry.isDirectory()) continue;

    const skillMdPath = path.join(skillsDir, entry.name, 'SKILL.md');
    if (!fs.existsSync(skillMdPath)) continue;

    const content = fs.readFileSync(skillMdPath, 'utf8');
    const fmMatch = content.match(/^---\n([\s\S]*?)\n---/);
    let description = entry.name;
    let credentials: Array<{ key: string; label: string; required: boolean }> = [];

    if (fmMatch) {
      const lines = fmMatch[1]!.split('\n');
      const descLine = lines.find((l) => l.startsWith('description:'));
      if (descLine) {
        description = descLine.slice('description:'.length).trim();
      }
      // Parse credentials block (YAML list)
      const credStart = lines.findIndex((l) => l.trim() === 'credentials:');
      if (credStart !== -1) {
        for (let i = credStart + 1; i < lines.length; i++) {
          const line = lines[i]!;
          if (!line.startsWith('  -') && !line.startsWith('    ')) break;
          const keyMatch = line.match(/key:\s*["']?([^"'\n]+)["']?/);
          const labelMatch = line.match(/label:\s*["']?([^"'\n]+)["']?/);
          const requiredMatch = line.match(/required:\s*(true|false)/);
          if (keyMatch && labelMatch) {
            credentials.push({
              key: keyMatch[1]!.trim(),
              label: labelMatch[1]!.trim(),
              required: requiredMatch ? requiredMatch[1] === 'true' : true,
            });
          }
        }
      }
    }

    skills.push({ name: entry.name, description, credentials });
  }

  return skills;
}

function getBundledSkillsDir(): string {
  const __dir = path.dirname(fileURLToPath(import.meta.url));
  return path.join(__dir, '..', 'skills');
}

async function copyBundledSkills(targetSkillsDir: string): Promise<{ copied: string[]; skipped: string[] }> {
  const bundledDir = getBundledSkillsDir();
  const copied: string[] = [];
  const skipped: string[] = [];

  if (!fs.existsSync(bundledDir)) {
    return { copied, skipped };
  }

  for (const entry of fs.readdirSync(bundledDir, { withFileTypes: true })) {
    if (!entry.isDirectory()) continue;
    const src = path.join(bundledDir, entry.name);
    const dst = path.join(targetSkillsDir, entry.name);

    if (fs.existsSync(dst)) {
      skipped.push(entry.name);
      continue;
    }

    fs.mkdirSync(dst, { recursive: true });
    copyDir(src, dst);
    copied.push(entry.name);
  }

  return { copied, skipped };
}

function copyDir(src: string, dst: string): void {
  for (const entry of fs.readdirSync(src, { withFileTypes: true })) {
    const srcPath = path.join(src, entry.name);
    const dstPath = path.join(dst, entry.name);
    if (entry.isDirectory()) {
      fs.mkdirSync(dstPath, { recursive: true });
      copyDir(srcPath, dstPath);
    } else {
      fs.copyFileSync(srcPath, dstPath);
    }
  }
}

function saveOnboardConfig(config: OnboardConfig, credentials?: Record<string, string>): void {
  const envLines: string[] = [
    '# AgentOctopus Configuration',
    `# Generated by octopus onboard on ${new Date().toISOString()}`,
    '',
  ];

  const v2: OctopusConfigV2 = { version: 2 };
  if (credentials && Object.keys(credentials).length > 0) {
    v2.credentials = credentials;
  }

  // LLM
  v2.llm = { provider: config.llmProvider, model: config.llmModel };
  if (config.llmProvider === 'openai') {
    envLines.push(`OPENAI_API_KEY=${config.openaiApiKey || ''}`);
    v2.llm.apiKey = '${OPENAI_API_KEY}';
    v2.llm.baseUrl = config.openaiBaseUrl || 'https://api.openai.com/v1';
  }
  if (config.llmProvider === 'gemini' || config.geminiApiKey) {
    envLines.push(`GEMINI_API_KEY=${config.geminiApiKey || ''}`);
    if (!config.openaiApiKey) v2.llm.apiKey = '${GEMINI_API_KEY}';
  }
  if (config.llmProvider === 'ollama') {
    v2.llm.baseUrl = config.ollamaBaseUrl || 'http://localhost:11434';
  }

  // Embed
  const ep = config.embedSameProvider ? config.llmProvider : (config.embedProvider || config.llmProvider);
  v2.embed = { provider: ep, model: config.embedModel || 'text-embedding-3-small' };
  if (!config.embedSameProvider) {
    envLines.push(`EMBED_API_KEY=${config.embedApiKey || ''}`);
    v2.embed.apiKey = '${EMBED_API_KEY}';
    if (config.embedBaseUrl) v2.embed.baseUrl = config.embedBaseUrl;
  } else {
    v2.embed.apiKey = v2.llm?.apiKey ?? '';
    v2.embed.baseUrl = v2.llm?.baseUrl ?? '';
  }

  // Rerank
  v2.rerank = { model: config.rerankModel || config.llmModel };

  // Deploy mode
  v2.deploy = { mode: (config.executionMode === 'cloud' ? 'cloud' : 'local') as 'local' | 'cloud', root: null };

  // Agents
  if (config.agents.length > 0) {
    v2.agents = {
      default: config.agents[0]!.id,
      entries: config.agents.map((a) => ({
        id: a.id,
        name: a.name,
        dmPolicy: a.dmPolicy,
        sandbox: a.sandboxEnabled
          ? { enabled: true, backend: a.sandboxBackend }
          : { enabled: false, backend: 'none' as const },
      })),
    };
  }

  // Sandbox. feat/sandbox's canonical schema (packages/sandbox/src/schema.ts)
  // is fail-closed: docker.image must be an immutable digest (not a mutable
  // tag like 'node:20-alpine'), and docker.network was removed entirely —
  // the egress proxy is the skill's sole network egress. The wizard can't
  // prompt for a 64-hex digest, so it sets only defaultBackend (the user's
  // choice) and leaves docker.image/runtimeProfiles to be filled by the
  // resolver defaults or an operator-supplied octopus.json. 'auto' is the
  // fail-closed default; 'none' disables sandboxing.
  if (config.sandboxDefaultBackend !== 'none') {
    v2.sandbox = {
      defaultBackend: config.sandboxDefaultBackend,
    };
  }

  // Webhook config
  if (config.enableWebhook) {
    (v2.gateway as any).webhookPort = 3005;
    (v2.gateway as any).webhookPath = '/webhook';
  }

  // Evolution
  v2.evolution = {
    enabled: config.enableEvolution,
    autoApplySafe: true,
    signalThreshold: 10,
    feedbackThreshold: 3,
    staleDays: 30,
    maxHistorySnapshots: 20,
    scheduleCron: '0 3 * * *',
  };

  envLines.push('');
  saveEnvFile(envLines.join('\n') + '\n');
  saveConfigFile(v2);

  console.log(`\nConfig written to ${getConfigPath()} and ${getEnvPath()}`);
}

// ─── Main ────────────────────────────────────────────────────────────────────

export async function runOnboarding(_rootDir?: string): Promise<void> {
  const totalSteps = 9;

  printBanner();

  // ── Step 0: Skills Directory ────────────────────────────────────────────
  printStep(0, totalSteps, 'Skills Directory');

  const defaultSkillsDir = path.join(getConfigDir(), 'skills');

  const chosenSkillsDir = await input({
    message: 'Where should AgentOctopus store your skills?',
    default: defaultSkillsDir,
  });

  const resolvedSkillsDir = path.resolve(chosenSkillsDir);
  fs.mkdirSync(resolvedSkillsDir, { recursive: true });

  console.log(chalk.gray('\n  Copying bundled skills...'));
  const { copied, skipped } = await copyBundledSkills(resolvedSkillsDir);

  if (copied.length > 0) {
    console.log(chalk.green(`  Installed: ${copied.join(', ')}`));
  }
  if (skipped.length > 0) {
    console.log(chalk.gray(`  Already exists (skipped): ${skipped.join(', ')}`));
  }
  console.log('');

  // Save config early so bootstrap() can find skills
  const ratingsPath = path.join(getConfigDir(), 'ratings.json');
  saveConfigFile({ version: 2, registry: { skillsDir: resolvedSkillsDir, ratingsPath } });

  // Check if config already exists
  const configPath = getConfigPath();
  if (fs.existsSync(configPath)) {
    const overwrite = await confirm({
      message: chalk.yellow('An octopus.json config already exists. Overwrite it?'),
      default: false,
    });

    if (!overwrite) {
      console.log(chalk.gray('\n  Keeping existing config. Exiting setup.\n'));
      return;
    }
  }

  const config: OnboardConfig = {
    llmProvider: 'openai',
    llmModel: 'gpt-4o',
    embedSameProvider: true,
    executionMode: 'local',
    disabledSkills: [],
    enableEvolution: false,
    agents: [{ id: 'default', name: 'Default Agent', dmPolicy: 'pairing', sandboxEnabled: false, sandboxBackend: 'none' }],
    sandboxDefaultBackend: 'none',
    enableSlack: false,
    enableDiscord: false,
    enableTelegram: false,
    enableWebhook: false,
  };

  // ── Step 1: LLM Provider ────────────────────────────────────────────────

  printStep(1, totalSteps, 'LLM Provider');

  config.llmProvider = await select({
    message: 'Select your LLM provider:',
    choices: [
      {
        value: 'openai' as const,
        name: '🔵  OpenAI (or compatible API like Azure, ChatAnywhere)',
        description: 'GPT-4o, GPT-4o-mini, and compatible endpoints',
      },
      {
        value: 'gemini' as const,
        name: '🟡  Google Gemini',
        description: 'Gemini Pro, Ultra, Flash',
      },
      {
        value: 'ollama' as const,
        name: '🟢  Ollama (Local)',
        description: 'Run LLMs locally — Llama, Mistral, etc.',
      },
    ],
  });

  if (config.llmProvider === 'openai') {
    config.openaiApiKey = await password({
      message: 'OpenAI API Key (sk-...):',
      mask: '*',
      validate: (v) => (v.length > 0 ? true : 'API Key is required'),
    });

    config.openaiBaseUrl = await input({
      message: 'Base URL:',
      default: 'https://api.openai.com/v1',
    });

    config.llmModel = await input({
      message: 'Model name:',
      default: 'gpt-4o-mini',
    });
  } else if (config.llmProvider === 'gemini') {
    config.geminiApiKey = await password({
      message: 'Gemini API Key:',
      mask: '*',
      validate: (v) => (v.length > 0 ? true : 'API Key is required'),
    });

    config.llmModel = await input({
      message: 'Model name:',
      default: 'gemini-2.0-flash',
    });
  } else if (config.llmProvider === 'ollama') {
    config.ollamaBaseUrl = await input({
      message: 'Ollama base URL:',
      default: 'http://localhost:11434',
    });

    config.ollamaModel = await input({
      message: 'Model name:',
      default: 'llama3.2',
    });

    config.llmModel = config.ollamaModel;
  }

  // ── Step 2: Embeddings ─────────────────────────────────────────────────

  printStep(2, totalSteps, 'Embedding Configuration');

  config.embedSameProvider = await confirm({
    message: `Use same provider (${config.llmProvider}) for embeddings?`,
    default: true,
  });

  if (!config.embedSameProvider) {
    config.embedProvider = await select({
      message: 'Select embedding provider:',
      choices: [
        { value: 'openai' as const, name: '🔵  OpenAI' },
        { value: 'gemini' as const, name: '🟡  Google Gemini' },
        { value: 'ollama' as const, name: '🟢  Ollama (Local)' },
      ],
    });

    if (config.embedProvider === 'openai') {
      config.embedApiKey = await password({
        message: 'Embedding API Key:',
        mask: '*',
      });

      config.embedBaseUrl = await input({
        message: 'Embedding Base URL:',
        default: 'https://api.openai.com/v1',
      });
    } else if (config.embedProvider === 'gemini') {
      config.embedApiKey = await password({
        message: 'Gemini API Key for embeddings:',
        mask: '*',
      });
    } else if (config.embedProvider === 'ollama') {
      config.embedBaseUrl = await input({
        message: 'Ollama base URL for embeddings:',
        default: config.ollamaBaseUrl || 'http://localhost:11434',
      });
    }
  }

  config.embedModel = await input({
    message: 'Embedding model name:',
    default: 'text-embedding-3-small',
  });

  config.rerankModel = await input({
    message: 'Rerank model (used for final skill selection):',
    default: config.llmModel || 'gpt-4o-mini',
  });

  // ── Step 3: Execution Mode ─────────────────────────────────────────────

  printStep(3, totalSteps, 'Execution Mode');

  config.executionMode = await select({
    message: 'Where should skills execute?',
    choices: [
      {
        value: 'local' as const,
        name: '💻  Local only — all skills run on your machine',
        description: 'Best for development and privacy',
      },
      {
        value: 'cloud' as const,
        name: '☁️   Cloud only — use AgentOctopus Cloud',
        description: 'No local setup needed, requires API key',
      },
      {
        value: 'hybrid' as const,
        name: '🔄  Hybrid — prefer local, fallback to cloud',
        description: 'Best of both worlds',
      },
    ],
  });

  if (config.executionMode === 'cloud' || config.executionMode === 'hybrid') {
    config.cloudGatewayUrl = await input({
      message: 'Cloud gateway URL:',
      default: 'https://api.agentoctopus.dev',
    });

    config.cloudApiKey = await password({
      message: 'Cloud API Key (leave empty to use free tier):',
      mask: '*',
    });

    if (!config.cloudApiKey) {
      console.log(chalk.gray('\n  ℹ  No Cloud API Key provided.'));
      console.log(chalk.gray('     You can register for a free key at:'));
      console.log(chalk.cyan('     https://api.agentoctopus.dev/register\n'));
    }
  }

  // ── Step 5: Skill Selection ────────────────────────────────────────────
  printStep(5, totalSteps, 'Skill Selection');

  const availableSkills = discoverSkills(resolvedSkillsDir);
  const collectedCredentials: Record<string, string> = {};

  if (availableSkills.length === 0) {
    console.log(chalk.gray('  No skills found. Skipping skill selection.'));
    console.log(chalk.gray('  Install skills later with: ') + chalk.yellow('octopus skill add <skill>'));
  } else {
    const enabledSkills = await checkbox({
      message: 'Select skills to enable:',
      choices: availableSkills.map((s) => ({
        value: s.name,
        name: `${s.name}${s.credentials.length > 0 ? ' 🔑' : ''} — ${chalk.gray(s.description)}`,
        checked: true,
      })),
    });

    config.disabledSkills = availableSkills
      .map((s) => s.name)
      .filter((name) => !enabledSkills.includes(name));

    // Prompt for credentials of enabled skills that need them
    for (const skill of availableSkills) {
      if (config.disabledSkills.includes(skill.name)) continue;
      for (const cred of skill.credentials) {
        if (collectedCredentials[cred.key]) continue;
        console.log('');
        console.log(chalk.cyan(`  Skill "${skill.name}" requires an API key:`));
        const value = await password({
          message: `  ${cred.label}:`,
          mask: '*',
          validate: cred.required ? (v) => (v.length > 0 ? true : 'This key is required') : undefined,
        });
        if (value) collectedCredentials[cred.key] = value;
      }
    }

    // Collected credentials will be saved to .env at the end
  }

  // ── Step 5.5: Agents ────────────────────────────────────────────────────
  printStep(6, totalSteps, 'Agents (Multi-Agent Setup)');

  const multiAgentEnabled = await confirm({
    message: 'Enable multiple isolated agents?\n' +
      chalk.gray('  Each agent has its own workspace, skills, and configuration.\n') +
      chalk.gray('  You can route different channels to different agents.'),
    default: false,
  });

  if (multiAgentEnabled) {
    const agentCount = Number(await input({
      message: 'How many agents do you want to create?',
      default: '2',
      validate: (v) => {
        const n = Number(v);
        return n >= 1 && n <= 10 ? true : 'Enter a number between 1 and 10';
      },
    }));

    config.agents = [];
    for (let i = 0; i < agentCount; i++) {
      const agentId = await input({
        message: `Agent ${i + 1} ID (lowercase, no spaces):`,
        default: i === 0 ? 'default' : `agent-${i + 1}`,
      });
      const agentName = await input({
        message: `Agent ${i + 1} display name:`,
        default: agentId,
      });
      const dmPolicy = await select({
        message: `Agent "${agentName}" DM security policy:`,
        choices: [
          { value: 'pairing' as const, name: '🔒  Pairing — unknown senders must pair first', description: 'Secure for private bots' },
          { value: 'open' as const, name: '🔓  Open — accept all DMs', description: 'For public/community bots' },
        ],
      });
      const sandboxEnabled = await confirm({
        message: `Enable sandbox for agent "${agentName}"?`,
        default: false,
      });
      const sandboxBackend = sandboxEnabled ? await select({
        message: 'Sandbox backend:',
        choices: [
          { value: 'auto' as const, name: '🛡️  Auto — fail-closed best available (recommended)', description: 'Picks the strongest isolation the host can enforce; never falls back to host' },
          { value: 'docker' as const, name: '🐳  Docker — isolated containers', description: 'Requires Docker daemon + immutable runtime image' },
          { value: 'os' as const, name: '🖥️  OS — restricted local execution', description: 'Opt-in restricted floor; not a pass-through' },
          { value: 'vm' as const, name: '📦  VM — microVM (libkrun)', description: 'Strongest local isolation; macOS/Linux only' },
          { value: 'ssh' as const, name: '🔑  SSH — remote host execution', description: 'Requires SSH access to a remote host' },
        ],
      }) : 'none' as const;

      config.agents.push({ id: agentId, name: agentName, dmPolicy, sandboxEnabled, sandboxBackend });
    }

    console.log(chalk.green(`\n  ✓ Created ${config.agents.length} agent(s).`));
  } else {
    console.log(chalk.gray('\n  Single default agent configured. You can add agents later with: ') + chalk.cyan('octopus agent create <name>'));
  }

  // ── Step 5.6: Sandbox ────────────────────────────────────────────────────
  printStep(7, totalSteps, 'Sandbox (Skill Isolation)');

  const sandboxEnabled = await confirm({
    message: 'Enable sandbox execution for skills?\n' +
      chalk.gray('  Sandboxed skills run in isolated containers or remote hosts.\n') +
      chalk.gray('  Recommended for untrusted or resource-heavy skills.'),
    default: false,
  });

  if (sandboxEnabled) {
    config.sandboxDefaultBackend = await select({
      message: 'Default sandbox backend:',
      choices: [
        { value: 'auto' as const, name: '🛡️  Auto — fail-closed best available (recommended)', description: 'Picks the strongest isolation the host can enforce; never falls back to host' },
        { value: 'docker' as const, name: '🐳  Docker — isolated containers', description: 'Requires Docker daemon + immutable runtime image' },
        { value: 'os' as const, name: '🖥️  OS — restricted local execution', description: 'Opt-in restricted floor; not a pass-through' },
        { value: 'vm' as const, name: '📦  VM — microVM (libkrun)', description: 'Strongest local isolation; macOS/Linux only' },
        { value: 'ssh' as const, name: '🔑  SSH — remote host execution', description: 'Requires SSH access to a remote host' },
      ],
    });

    if (config.sandboxDefaultBackend === 'docker') {
      console.log(chalk.gray('  Docker sandbox uses the immutable runtime image from your octopus.json (sandbox.docker.image).'));
    } else if (config.sandboxDefaultBackend === 'ssh') {
      console.log(chalk.yellow('  ⚠  Remember to configure ssh.host and ssh.user in ~/.agentoctopus/octopus.json'));
    }
  }

  // ── Step 5.7: Channels ────────────────────────────────────────────────────
  printStep(8, totalSteps, 'Channels (IM & Web)');

  config.enableSlack = await confirm({
    message: 'Enable Slack bot? (requires SLACK_BOT_TOKEN in .env)',
    default: false,
  });
  config.enableDiscord = await confirm({
    message: 'Enable Discord bot? (requires DISCORD_TOKEN in .env)',
    default: false,
  });
  config.enableTelegram = await confirm({
    message: 'Enable Telegram bot? (requires TELEGRAM_BOT_TOKEN in .env)',
    default: false,
  });
  config.enableWebhook = await confirm({
    message: 'Enable HTTP Webhook channel?',
    default: false,
  });

  if (config.enableSlack || config.enableDiscord || config.enableTelegram || config.enableWebhook) {
    console.log(chalk.green('\n  ✓ Channels configured.'));
    console.log(chalk.gray('    Add bot tokens to ~/.agentoctopus/.env'));
  }

  // ── Step 5.8: Evolution ─────────────────────────────────────────────────
  printStep(9, totalSteps, 'Skill Evolution');

  config.enableEvolution = await confirm({
    message: 'Enable AI-powered skill evolution?\n' +
      chalk.gray('  When enabled, AI monitors skill performance and auto-improves underperforming skills.\n') +
      chalk.gray('  Safe changes are applied automatically; risky changes require your approval.'),
    default: true,
  });

  if (config.enableEvolution) {
    console.log(chalk.green('\n  ✓ Evolution enabled.'));
    console.log(chalk.gray('    Review pending changes anytime with: ') + chalk.cyan('octopus evolve --review'));
  } else {
    console.log(chalk.gray('\n  Evolution disabled. You can enable it later in ~/.agentoctopus/octopus.json'));
  }

  // ── Step 7: Review & Save ──────────────────────────────────────────────

  printStep(7, totalSteps, 'Review & Save');

  console.log(chalk.white.bold('  Configuration Summary:'));
  console.log('');
  console.log(`  ${chalk.gray('LLM Provider:')}    ${chalk.cyan(config.llmProvider)}`);
  console.log(`  ${chalk.gray('LLM Model:')}       ${chalk.cyan(config.llmModel)}`);
  console.log(`  ${chalk.gray('Embed Provider:')}   ${chalk.cyan(config.embedSameProvider ? config.llmProvider : (config.embedProvider || config.llmProvider))}`);
  console.log(`  ${chalk.gray('Embed Model:')}      ${chalk.cyan(config.embedModel || 'text-embedding-3-small')}`);
  console.log(`  ${chalk.gray('Execution Mode:')}   ${chalk.cyan(config.executionMode)}`);

  if (availableSkills.length > 0) {
    const enabledCount = availableSkills.length - config.disabledSkills.length;
    console.log(`  ${chalk.gray('Skills:')}           ${chalk.cyan(`${enabledCount}/${availableSkills.length} enabled`)}`);

    if (config.disabledSkills.length > 0) {
      console.log(`  ${chalk.gray('Disabled:')}         ${chalk.yellow(config.disabledSkills.join(', '))}`);
    }
  }

  console.log(`  ${chalk.gray('Agents:')}          ${chalk.cyan(config.agents.length)}`);
  for (const agent of config.agents) {
    const sb = agent.sandboxEnabled ? ` [sandbox:${agent.sandboxBackend}]` : '';
    console.log(`    ${chalk.cyan('•')} ${agent.name}${chalk.gray(` (${agent.id}, dm:${agent.dmPolicy})${sb}`)}`);
  }

  if (config.sandboxDefaultBackend !== 'none') {
    console.log(`  ${chalk.gray('Sandbox:')}         ${chalk.cyan(config.sandboxDefaultBackend)}`);
  }

  const channels: string[] = [];
  if (config.enableSlack) channels.push('Slack');
  if (config.enableDiscord) channels.push('Discord');
  if (config.enableTelegram) channels.push('Telegram');
  if (config.enableWebhook) channels.push('Webhook');
  channels.push('WebChat');
  console.log(`  ${chalk.gray('Channels:')}        ${chalk.cyan(channels.join(', '))}`);

  console.log(`  ${chalk.gray('Evolution:')}       ${config.enableEvolution ? chalk.green('enabled') : chalk.gray('disabled')}`);

  console.log('');

  const confirmed = await confirm({
    message: 'Save this configuration?',
    default: true,
  });

  if (!confirmed) {
    console.log(chalk.yellow('\n  Setup cancelled. No changes were made.\n'));
    return;
  }

  // Write config to ~/.agentoctopus/
  saveOnboardConfig(config, collectedCredentials);

  // Append collected skill credentials to .env
  if (Object.keys(collectedCredentials).length > 0) {
    let envContent = fs.readFileSync(getEnvPath(), 'utf8');
    for (const [k, v] of Object.entries(collectedCredentials)) {
      envContent += `${k}=${v}\n`;
    }
    fs.writeFileSync(getEnvPath(), envContent, 'utf8');
  }

  console.log(chalk.green.bold('  Configuration saved.'));
  console.log('');
  console.log(chalk.gray('  Next steps:'));
  console.log(chalk.white('    1. ') + chalk.cyan('octopus ask "translate hello to French"') + chalk.gray('  — test routing'));
  console.log(chalk.white('    2. ') + chalk.cyan('octopus list') + chalk.gray('                               — see available skills'));
  console.log(chalk.white('    3. ') + chalk.cyan('octopus start') + chalk.gray('                              — start web UI + gateway'));
  console.log('');
}

/**
 * Check whether onboarding is needed (no .env file exists).
 * Returns true if the user completed onboarding or already has an .env.
 */
export async function ensureOnboarded(_rootDir?: string): Promise<boolean> {
  const configPath = getConfigPath();

  if (fs.existsSync(configPath)) {
    return true;
  }

  console.log(chalk.yellow('\n  No octopus.json found. Let\'s set up AgentOctopus first.\n'));

  const runSetup = await confirm({
    message: 'Run setup wizard now?',
    default: true,
  });

  if (runSetup) {
    await runOnboarding();
    return fs.existsSync(configPath);
  }

  console.log(chalk.gray('\n  You can run setup later with: ') + chalk.yellow('octopus onboard'));
  console.log(chalk.gray('  Or manually create ~/.agentoctopus/octopus.json\n'));
  return false;
}
