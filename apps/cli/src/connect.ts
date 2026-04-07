import fs from 'fs';
import path from 'path';
import os from 'os';
import chalk from 'chalk';
import { loadOctopusConfig, saveOctopusConfig, getDefaultHome } from './config.js';

interface OpenClawAuthProfiles {
  version: number;
  profiles: Record<string, {
    type: string;
    provider: string;
    key: string;
  }>;
}

interface OpenClawModels {
  providers: Record<string, {
    baseUrl: string;
  }>;
}

interface OpenClawMain {
  agents?: {
    defaults?: {
      model?: {
        primary?: string;
      };
    };
  };
}

export interface OpenClawExtracted {
  provider: 'openai' | 'gemini' | 'ollama';
  apiKey: string;
  baseUrl: string;
  model: string;
}

export function extractOpenClawConfig(openClawHome: string): OpenClawExtracted | null {
  const agentDir = path.join(openClawHome, 'agents', 'main', 'agent');
  const authProfilesPath = path.join(agentDir, 'auth-profiles.json');
  const modelsPath = path.join(agentDir, 'models.json');
  const mainConfigPath = path.join(openClawHome, 'openclaw.json');

  if (!fs.existsSync(authProfilesPath)) return null;

  let authProfiles: OpenClawAuthProfiles;
  let models: OpenClawModels = { providers: {} };
  let mainConfig: OpenClawMain = {};

  try {
    authProfiles = JSON.parse(fs.readFileSync(authProfilesPath, 'utf8')) as OpenClawAuthProfiles;
  } catch {
    return null;
  }

  try {
    models = JSON.parse(fs.readFileSync(modelsPath, 'utf8')) as OpenClawModels;
  } catch { /* optional */ }

  try {
    mainConfig = JSON.parse(fs.readFileSync(mainConfigPath, 'utf8')) as OpenClawMain;
  } catch { /* optional */ }

  const profiles = authProfiles.profiles ?? {};
  const entry = Object.values(profiles).find(p => p.key && p.provider);
  if (!entry) return null;

  const provider: 'openai' | 'gemini' | 'ollama' =
    entry.provider === 'openrouter' || entry.provider === 'openai' ? 'openai' :
    entry.provider === 'gemini' ? 'gemini' :
    entry.provider === 'ollama' ? 'ollama' :
    'openai';

  const baseUrl = models.providers[entry.provider]?.baseUrl ?? 'https://api.openai.com/v1';
  const model = mainConfig.agents?.defaults?.model?.primary ?? 'openrouter/auto';

  return { provider, apiKey: entry.key, baseUrl, model };
}

export async function connectOpenClaw(): Promise<void> {
  const openClawHome = path.join(os.homedir(), '.openclaw');

  if (!fs.existsSync(openClawHome)) {
    console.error(chalk.red('\n  OpenClaw is not installed (no ~/.openclaw directory found).\n'));
    process.exitCode = 1;
    return;
  }

  const extracted = extractOpenClawConfig(openClawHome);

  if (!extracted) {
    console.error(chalk.red('\n  Could not find a usable LLM profile in OpenClaw.'));
    console.error(chalk.gray('  Run the OpenClaw setup wizard first, then retry.\n'));
    process.exitCode = 1;
    return;
  }

  console.log(chalk.bold('\n  Found OpenClaw LLM configuration:\n'));
  console.log(chalk.gray(`    Provider : ${extracted.provider} (${extracted.baseUrl})`));
  console.log(chalk.gray(`    Model    : ${extracted.model}`));
  console.log(chalk.gray(`    API Key  : ${extracted.apiKey.slice(0, 8)}...\n`));

  const existing = loadOctopusConfig();
  const skillsDir = existing?.skillsDir ?? path.join(getDefaultHome(), 'skills');
  const ratingsPath = existing?.ratingsPath ?? path.join(getDefaultHome(), 'ratings.json');
  const credentials = existing?.credentials ?? {};

  credentials['LLM_PROVIDER'] = extracted.provider;
  credentials['LLM_MODEL'] = extracted.model;
  credentials['OPENAI_API_KEY'] = extracted.apiKey;
  credentials['OPENAI_BASE_URL'] = extracted.baseUrl;
  credentials['EMBED_PROVIDER'] = extracted.provider;
  credentials['EMBED_MODEL'] = 'text-embedding-3-small';
  credentials['EMBED_API_KEY'] = extracted.apiKey;
  credentials['EMBED_BASE_URL'] = extracted.baseUrl;

  saveOctopusConfig({ skillsDir, ratingsPath, credentials });

  console.log(chalk.green('  AgentOctopus configured with your OpenClaw LLM settings.'));
  console.log(chalk.gray(`  Config saved to: ${path.join(getDefaultHome(), 'octopus.json')}\n`));
  console.log(chalk.cyan('  You can now run: octopus ask "translate hello to French"\n'));
}
