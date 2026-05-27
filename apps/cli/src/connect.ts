import fs from 'fs';
import path from 'path';
import os from 'os';
import http from 'http';
import https from 'https';
import chalk from 'chalk';
import { saveConfigFile, saveEnvFile, getConfigPath, createChatClient, createEmbedClient, type OctopusConfigV2 } from '@agentoctopus/core';

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

// Provider-aware baseUrl defaults so Gemini/Ollama/OpenCode users get the right endpoint.
const providerBaseUrlDefaults: Record<string, string> = {
  openrouter: 'https://openrouter.ai/api/v1',
  openai: 'https://api.openai.com/v1',
  gemini: 'https://generativelanguage.googleapis.com/v1beta',
  ollama: 'http://localhost:11434',
  'opencode-go': 'https://opencode.ai/zen/go/v1',
  opencode: 'https://opencode.ai/zen/go/v1',
};

// Provider-aware model defaults.
const providerModelDefaults: Record<string, string> = {
  openrouter: 'openrouter/auto',
  openai: 'gpt-4o-mini',
  gemini: 'gemini-1.5-flash',
  ollama: 'llama3.2',
  'opencode-go': 'opencode-go/kimi-k2.6',
  opencode: 'opencode/kimi-k2.6',
};

// Provider-aware embedding model defaults.
const embedModelDefaults: Record<string, string> = {
  openai: 'text-embedding-3-small',
  gemini: 'text-embedding-004',
  ollama: 'nomic-embed-text',
};

function mapProvider(rawProvider: string): 'openai' | 'gemini' | 'ollama' {
  return rawProvider === 'gemini' ? 'gemini' :
    rawProvider === 'ollama' ? 'ollama' :
    'openai';
}

/**
 * Strip the provider prefix from a model name if it matches the current provider.
 * OpenClaw stores models as "provider/model" (e.g. "opencode-go/deepseek-v4-flash"),
 * but the actual API only needs the model part ("deepseek-v4-flash").
 * OpenRouter models like "qwen/qwen3-plus:free" are kept as-is since the prefix
 * is part of the model identifier in OpenRouter's API.
 */
function stripModelPrefix(model: string, rawProvider: string): string {
  if (model.includes('/') && model.startsWith(rawProvider + '/')) {
    return model.slice(rawProvider.length + 1);
  }
  return model;
}

function resolveBaseUrl(rawProvider: string, models: OpenClawModels, mainConfig: OpenClawMain): string {
  return models.providers[rawProvider]?.baseUrl ??
    (mainConfig as any).models?.providers?.[rawProvider]?.baseUrl ??
    providerBaseUrlDefaults[rawProvider] ??
    'https://api.openai.com/v1';
}

export function extractOpenClawConfig(openClawHome: string): OpenClawExtracted | null {
  const all = extractAllOpenClawConfigs(openClawHome);
  return all.length > 0 ? all[0] : null;
}

/**
 * Extract ALL OpenClaw LLM profiles, ordered by preference:
 * 1. Active provider (from openclaw.json model setting) first
 * 2. lastGood providers next
 * 3. Remaining providers last
 */
export function extractAllOpenClawConfigs(openClawHome: string): OpenClawExtracted[] {
  const agentDir = path.join(openClawHome, 'agents', 'main', 'agent');
  const authProfilesPath = path.join(agentDir, 'auth-profiles.json');
  const modelsPath = path.join(agentDir, 'models.json');
  const mainConfigPath = path.join(openClawHome, 'openclaw.json');

  if (!fs.existsSync(authProfilesPath)) return [];

  let authProfiles: OpenClawAuthProfiles;
  let models: OpenClawModels = { providers: {} };
  let mainConfig: OpenClawMain = {};

  try {
    authProfiles = JSON.parse(fs.readFileSync(authProfilesPath, 'utf8')) as OpenClawAuthProfiles;
  } catch {
    return [];
  }

  try {
    models = JSON.parse(fs.readFileSync(modelsPath, 'utf8')) as OpenClawModels;
  } catch { /* optional */ }

  try {
    mainConfig = JSON.parse(fs.readFileSync(mainConfigPath, 'utf8')) as OpenClawMain;
  } catch { /* optional */ }

  const profiles = authProfiles.profiles ?? {};

  // 1. Determine active model and provider from openclaw.json
  const mainAgent = (mainConfig as any).agents?.list?.find((a: any) => a.id === 'main');
  const rawActiveModel = mainAgent?.model?.primary ?? mainConfig.agents?.defaults?.model?.primary;
  let activeProvider: string | undefined;
  if (rawActiveModel && rawActiveModel.includes('/')) {
    activeProvider = rawActiveModel.split('/')[0];
  }

  // 2. Collect lastGood providers for priority ordering
  let lastGood: Record<string, string> = {};
  try {
    const authStatePath = path.join(agentDir, 'auth-state.json');
    if (fs.existsSync(authStatePath)) {
      const authState = JSON.parse(fs.readFileSync(authStatePath, 'utf8'));
      lastGood = authState.lastGood ?? {};
    }
  } catch { /* optional */ }
  if (Object.keys(lastGood).length === 0) {
    lastGood = authProfiles.lastGood ?? {};
  }
  const lastGoodProviders = new Set(Object.values(lastGood).map(key => profiles[key]?.provider).filter(Boolean));

  // 3. Build ordered list of entries: active → lastGood → rest
  const seenProviders = new Set<string>();
  const orderedEntries: { provider: string; key: string; model: string }[] = [];
  let activeModelUsed = false;

  // Active provider first — if the activeModel's provider has a profile, use it with stripped prefix
  if (activeProvider) {
    const entry = Object.values(profiles).find(p => p.provider === activeProvider && p.key);
    if (entry) {
      const model = stripModelPrefix(rawActiveModel!, entry.provider);
      orderedEntries.push({ provider: entry.provider, key: entry.key, model });
      seenProviders.add(activeProvider);
      activeModelUsed = true;
    }
  }

  // lastGood providers next
  for (const key of Object.values(lastGood)) {
    const p = profiles[key];
    if (p?.key && p.provider && !seenProviders.has(p.provider)) {
      // If activeModel wasn't used by its own provider, apply it here (prefix is part of model name)
      const model = !activeModelUsed && rawActiveModel ? rawActiveModel! : (providerModelDefaults[p.provider] ?? 'openrouter/auto');
      orderedEntries.push({ provider: p.provider, key: p.key, model });
      seenProviders.add(p.provider);
      if (!activeModelUsed && rawActiveModel) activeModelUsed = true;
    }
  }

  // Remaining providers
  for (const p of Object.values(profiles)) {
    if (p.key && p.provider && !seenProviders.has(p.provider)) {
      const model = !activeModelUsed && rawActiveModel ? rawActiveModel! : (providerModelDefaults[p.provider] ?? 'openrouter/auto');
      orderedEntries.push({ provider: p.provider, key: p.key, model });
      seenProviders.add(p.provider);
      if (!activeModelUsed && rawActiveModel) activeModelUsed = true;
    }
  }

  // 4. Map to OpenClawExtracted
  return orderedEntries.map(e => ({
    provider: mapProvider(e.provider),
    rawProvider: e.provider,
    apiKey: e.key,
    baseUrl: resolveBaseUrl(e.provider, models, mainConfig),
    model: e.model,
  }));
}

/**
 * Lightweight HTTP reachability check — sends a HEAD request to the base URL
 * with a short timeout. Returns true if the server responds (any status),
 * false if unreachable or timed out.
 */
export function checkServiceReachable(baseUrl: string, timeoutMs = 5000): Promise<boolean> {
  return new Promise((resolve) => {
    const url = new URL(baseUrl);
    const lib = url.protocol === 'https:' ? https : http;
    const req = lib.request(`${url.protocol}//${url.host}`, { method: 'HEAD', timeout: timeoutMs }, (res) => {
      res.resume(); // drain the response
      resolve(true);
    });
    req.on('error', () => resolve(false));
    req.on('timeout', () => { req.destroy(); resolve(false); });
    req.end();
  });
}

export async function connectOpenClaw(): Promise<void> {
  const openClawHome = path.join(os.homedir(), '.openclaw');

  if (!fs.existsSync(openClawHome)) {
    console.error(chalk.red('\n  OpenClaw is not installed (no ~/.openclaw directory found).\n'));
    process.exitCode = 1;
    return;
  }

  const allConfigs = extractAllOpenClawConfigs(openClawHome);

  if (allConfigs.length === 0) {
    console.error(chalk.red('\n  Could not find any usable LLM profile in OpenClaw.'));
    console.error(chalk.cyan('  Run `octopus onboard` to set up AgentOctopus manually.\n'));
    process.exitCode = 1;
    return;
  }

  console.log(chalk.bold(`\n  Found ${allConfigs.length} LLM profile(s) in OpenClaw. Testing availability...\n`));

  // Iterate through all profiles to find a working one
  let workingConfig: OpenClawExtracted | null = null;
  const failedProviders: string[] = [];

  for (const extracted of allConfigs) {
    console.log(chalk.blue(`  Checking ${extracted.rawProvider} (${extracted.baseUrl})...`));

    // Step 1: Quick reachability check
    const reachable = await checkServiceReachable(extracted.baseUrl);
    if (!reachable) {
      console.log(chalk.yellow(`  ✗ ${extracted.rawProvider}: service unreachable\n`));
      failedProviders.push(`${extracted.rawProvider} (unreachable)`);
      continue;
    }

    // Step 2: LLM chat verification
    try {
      const client = createChatClient({
        provider: extracted.provider,
        model: extracted.model,
        apiKey: extracted.apiKey,
        baseUrl: extracted.baseUrl,
      });
      await client.chat('You are a connectivity test assistant.', 'Respond with "ok" and nothing else.');
      console.log(chalk.green(`  ✓ ${extracted.rawProvider}: LLM service available\n`));
      workingConfig = extracted;
      break;
    } catch (err: any) {
      const isModelError = err.message && (
        err.message.includes('model') ||
        err.message.includes('Model') ||
        err.message.includes('supported') ||
        err.message.includes('support') ||
        err.message.includes('401') ||
        err.message.includes('404')
      );
      const defaultModel = providerModelDefaults[extracted.rawProvider];
      if (isModelError && defaultModel && defaultModel !== extracted.model) {
        console.log(chalk.yellow(`  ℹ ${extracted.rawProvider}: model ${extracted.model} failed, trying fallback model ${defaultModel}...`));
        try {
          const fallbackClient = createChatClient({
            provider: extracted.provider,
            model: defaultModel,
            apiKey: extracted.apiKey,
            baseUrl: extracted.baseUrl,
          });
          await fallbackClient.chat('You are a connectivity test assistant.', 'Respond with "ok" and nothing else.');
          console.log(chalk.green(`  ✓ ${extracted.rawProvider}: LLM service available (using ${defaultModel})\n`));
          workingConfig = { ...extracted, model: defaultModel };
          break;
        } catch (fallbackErr: any) {
          console.log(chalk.yellow(`  ✗ ${extracted.rawProvider}: LLM verification failed with fallback model (${fallbackErr.message || fallbackErr})\n`));
          failedProviders.push(`${extracted.rawProvider} (auth failed)`);
        }
      } else {
        console.log(chalk.yellow(`  ✗ ${extracted.rawProvider}: LLM verification failed (${err.message || err})\n`));
        failedProviders.push(`${extracted.rawProvider} (auth failed)`);
      }
    }
  }

  if (!workingConfig) {
    console.error(chalk.red('  No available LLM service found.\n'));
    if (failedProviders.length > 0) {
      console.error(chalk.gray('  Tried:'));
      for (const f of failedProviders) {
        console.error(chalk.gray(`    - ${f}`));
      }
    }
    console.error(chalk.cyan('\n  Run `octopus onboard` to set up AgentOctopus manually.\n'));
    process.exitCode = 1;
    return;
  }

  console.log(chalk.bold('  Using OpenClaw LLM configuration:\n'));
  console.log(chalk.gray(`    Provider : ${workingConfig.provider} (${workingConfig.baseUrl})`));
  console.log(chalk.gray(`    Model    : ${workingConfig.model}`));
  console.log(chalk.gray(`    API Key  : ${workingConfig.apiKey.slice(0, 8)}...\n`));

  // Step 3: Test embedding service
  const supportsEmbedding = workingConfig.rawProvider !== 'openrouter';
  let embeddingAvailable = false;

  if (supportsEmbedding) {
    const embedModel = embedModelDefaults[workingConfig.rawProvider] ?? 'text-embedding-3-small';
    console.log(chalk.blue(`  Testing embedding service (${embedModel})...`));
    try {
      const embedClient = createEmbedClient({
        provider: workingConfig.provider,
        model: embedModel,
        apiKey: workingConfig.apiKey,
        baseUrl: workingConfig.baseUrl,
      });
      await embedClient.embed('test');
      embeddingAvailable = true;
      console.log(chalk.green('  ✓ Embedding service available!\n'));
    } catch (err: any) {
      console.log(chalk.yellow(`  ✗ Embedding service unavailable (${err.message || err})\n`));
    }
  } else {
    console.log(chalk.yellow('  OpenRouter does not support embeddings — using LLM-only mode.\n'));
  }

  // Step 4: Write config
  const v2: OctopusConfigV2 = { version: 2 };

  v2.llm = {
    provider: workingConfig.provider,
    model: workingConfig.model,
    apiKey: '${OPENAI_API_KEY}',
    baseUrl: workingConfig.baseUrl,
  };

  saveEnvFile(`OPENAI_API_KEY=${workingConfig.apiKey}\n`);

  if (embeddingAvailable) {
    const embedModel = embedModelDefaults[workingConfig.rawProvider] ?? 'text-embedding-3-small';
    v2.embed = {
      provider: workingConfig.provider,
      model: embedModel,
      apiKey: '${OPENAI_API_KEY}',
      baseUrl: workingConfig.baseUrl,
    };
  }

  saveConfigFile(v2);

  console.log(chalk.green('  AgentOctopus configured with your OpenClaw LLM settings.'));
  const routingMode = embeddingAvailable
    ? chalk.gray('  Routing mode: Embedding + LLM re-rank')
    : chalk.yellow('  Routing mode: LLM-only (no embedding service available)');
  console.log(routingMode);
  console.log(chalk.gray(`  Config saved to: ${getConfigPath()}\n`));
  console.log(chalk.cyan('  You can now run: octopus ask "translate hello to French"\n'));
}
