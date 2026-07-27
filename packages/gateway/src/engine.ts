import path from 'path';
import os from 'os';
import { SkillRegistry, syncFromCloud } from '@agentoctopus/registry';
import { Router, Executor, createChatClient, createDefaultSandboxRunner, buildSecretProviderFromConfig, type ChatClient, type LLMConfig, getConfig, loadConfig } from '@agentoctopus/core';

export const DIRECT_ANSWER_SYSTEM_PROMPT = 'You are a helpful assistant. Answer the user\'s question concisely and accurately.';

const DEFAULT_HOME = path.join(os.homedir(), '.agentoctopus');

export interface OctopusEngine {
  registry: SkillRegistry;
  router: Router;
  executor: Executor;
  chatClient: ChatClient;
}

let _engine: OctopusEngine | null = null;

export async function bootstrapEngine(rootDir?: string): Promise<OctopusEngine> {
  if (_engine) return _engine;

  const config = loadConfig();

  const skillsDir = path.join(DEFAULT_HOME, 'skills');
  const ratingsPath = path.join(DEFAULT_HOME, 'ratings.json');

  if (config.gateway.cloudUrl && config.gateway.syncOnStartup) {
    try {
      const result = await syncFromCloud(config.gateway.cloudUrl, skillsDir);
      const total = result.added.length + result.updated.length;
      if (total > 0) {
        console.log(`[Engine] Synced ${total} skill(s) from ${config.gateway.cloudUrl} (added: ${result.added.length}, updated: ${result.updated.length})`);
      }
    } catch (err) {
      console.warn(`[Engine] Startup sync from ${config.gateway.cloudUrl} failed: ${(err as Error).message}`);
    }
  }

  const registry = new SkillRegistry(skillsDir, ratingsPath);
  registry.noCache = config.registry.noCache;
  await registry.load();

  const chatConfig: LLMConfig = {
    provider: config.llm.provider,
    model: config.llm.model,
    apiKey: config.llm.apiKey || undefined,
    baseUrl: config.llm.baseUrl,
  };

  const rerankConfig: LLMConfig = {
    ...chatConfig,
    model: config.rerank.model,
  };

  const embedConfig: LLMConfig | undefined =
    config.embed.apiKey
      ? {
          provider: config.embed.provider,
          model: config.embed.model,
          apiKey: config.embed.apiKey,
          baseUrl: config.embed.baseUrl || chatConfig.baseUrl,
        }
      : undefined;

  const router = new Router(rerankConfig, embedConfig);
  await router.buildIndex(registry.getAll());

  const chatClient = createChatClient(rerankConfig);
  // Build the host-side secret provider from trusted config and converge the
  // Executor's execution boundary on a runner that provisions credentials ONLY
  // to the trusted egress proxy — never into a prompt, env spec, log, or error.
  const secretProvider = buildSecretProviderFromConfig(config);
  const sandboxRunner = createDefaultSandboxRunner(secretProvider);
  const executor = new Executor(registry, chatClient, router, sandboxRunner);

  _engine = { registry, router, executor, chatClient };
  return _engine;
}

export function resetEngine(): void {
  _engine = null;
}
