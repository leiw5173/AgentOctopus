import fs from 'fs';
import path from 'path';
import os from 'os';
import chalk from 'chalk';
import { saveConfigFile, saveEnvFile, getConfigPath, type OctopusConfigV2 } from '@agentoctopus/core';

interface OpenClawAuthProfiles {
  version: number;
  profiles: Record<string, {
    type: string;
    provider: string;
    key: string;
  }>;
  lastGood?: Record<string, string>;
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
  rawProvider: string;  // original provider name from OpenClaw (e.g. "openrouter")
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
  // Prefer the "lastGood" active profile if present; fall back to first match.
  // lastGood maps provider name → profile key (e.g. { openrouter: "openrouter:default" }).
  const lastGood = authProfiles.lastGood ?? {};
  const lastGoodKey = Object.values(lastGood).find(key => profiles[key]?.key && profiles[key]?.provider);
  const entry = (lastGoodKey ? profiles[lastGoodKey] : undefined) ?? Object.values(profiles).find(p => p.key && p.provider);
  if (!entry) return null;

  const provider: 'openai' | 'gemini' | 'ollama' =
    entry.provider === 'openrouter' || entry.provider === 'openai' ? 'openai' :
    entry.provider === 'gemini' ? 'gemini' :
    entry.provider === 'ollama' ? 'ollama' :
    'openai';

  // Provider-aware baseUrl defaults so Gemini/Ollama users get the right endpoint.
  const providerDefaults: Record<string, string> = {
    openrouter: 'https://openrouter.ai/api/v1',
    openai: 'https://api.openai.com/v1',
    gemini: 'https://generativelanguage.googleapis.com/v1beta',
    ollama: 'http://localhost:11434',
  };
  const baseUrl = models.providers[entry.provider]?.baseUrl ?? providerDefaults[entry.provider] ?? 'https://api.openai.com/v1';

  // Provider-aware model defaults.
  const modelDefaults: Record<string, string> = {
    openrouter: 'openrouter/auto',
    openai: 'gpt-4o-mini',
    gemini: 'gemini-1.5-flash',
    ollama: 'llama3.2',
  };
  const model = mainConfig.agents?.defaults?.model?.primary ?? modelDefaults[entry.provider] ?? 'openrouter/auto';

  return { provider, rawProvider: entry.provider, apiKey: entry.key, baseUrl, model };
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

  const v2: OctopusConfigV2 = { version: 2 };

  v2.llm = {
    provider: extracted.provider,
    model: extracted.model,
    apiKey: '${OPENAI_API_KEY}',
    baseUrl: extracted.baseUrl,
  };

  saveEnvFile(`OPENAI_API_KEY=${extracted.apiKey}\n`);

  const supportsEmbedding = extracted.rawProvider !== 'openrouter';
  if (supportsEmbedding) {
    const embedModelDefaults: Record<string, string> = { openai: 'text-embedding-3-small', gemini: 'text-embedding-004', ollama: 'nomic-embed-text' };
    v2.embed = {
      provider: extracted.provider,
      model: embedModelDefaults[extracted.rawProvider] ?? 'text-embedding-3-small',
      apiKey: '${OPENAI_API_KEY}',
      baseUrl: extracted.baseUrl,
    };
  }

  saveConfigFile(v2);

  console.log(chalk.green('  AgentOctopus configured with your OpenClaw LLM settings.'));
  const routingMode = supportsEmbedding
    ? chalk.gray('  Routing mode: Embedding + LLM re-rank')
    : chalk.yellow('  Routing mode: LLM-only (OpenRouter does not support embeddings)');
  console.log(routingMode);
  console.log(chalk.gray(`  Config saved to: ${getConfigPath()}\n`));
  console.log(chalk.cyan('  You can now run: octopus ask "translate hello to French"\n'));
}
