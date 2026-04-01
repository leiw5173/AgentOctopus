import path from 'path';
import { SkillRegistry, syncFromCloud } from '@agentoctopus/registry';
import { Router, Executor, createChatClient, type ChatClient, type LLMConfig } from '@agentoctopus/core';

export const DIRECT_ANSWER_SYSTEM_PROMPT = 'You are a helpful assistant. Answer the user\'s question concisely and accurately.';

export interface OctopusEngine {
  registry: SkillRegistry;
  router: Router;
  executor: Executor;
  chatClient: ChatClient;
}

let _engine: OctopusEngine | null = null;

/**
 * Bootstrap (or return cached) OctopusEngine from environment variables.
 * Designed to be called once and reused across gateway adapters.
 */
export async function bootstrapEngine(rootDir?: string): Promise<OctopusEngine> {
  if (_engine) return _engine;

  const root = rootDir ?? process.env.OCTOPUS_ROOT ?? process.cwd();
  const skillsDir = process.env.REGISTRY_PATH ?? path.join(root, 'registry', 'skills');
  const ratingsPath = process.env.RATINGS_PATH ?? path.join(root, 'registry', 'ratings.json');

  // Sync skills from cloud before loading registry (local mode)
  const cloudUrl = process.env.CLOUD_URL;
  if (cloudUrl && process.env.SYNC_ON_STARTUP !== 'false') {
    try {
      const result = await syncFromCloud(cloudUrl, skillsDir);
      const total = result.added.length + result.updated.length;
      if (total > 0) {
        console.log(`[Engine] Synced ${total} skill(s) from ${cloudUrl} (added: ${result.added.length}, updated: ${result.updated.length})`);
      }
    } catch (err) {
      console.warn(`[Engine] Startup sync from ${cloudUrl} failed: ${(err as Error).message}`);
    }
  }

  const registry = new SkillRegistry(skillsDir, ratingsPath);
  await registry.load();

  const provider = (process.env.LLM_PROVIDER as LLMConfig['provider']) ?? 'openai';
  const chatConfig: LLMConfig = {
    provider,
    model: process.env.LLM_MODEL ?? 'gpt-4o',
    apiKey: process.env.OPENAI_API_KEY ?? process.env.GEMINI_API_KEY,
    baseUrl: provider === 'openai' ? process.env.OPENAI_BASE_URL : process.env.OLLAMA_BASE_URL,
  };

  const embedProvider = (process.env.EMBED_PROVIDER as LLMConfig['provider']) ?? provider;
  const embedConfig: LLMConfig = {
    provider: embedProvider,
    model: process.env.EMBED_MODEL ?? 'text-embedding-3-small',
    apiKey: process.env.EMBED_API_KEY ?? chatConfig.apiKey,
    baseUrl: process.env.EMBED_BASE_URL ?? chatConfig.baseUrl,
  };

  const rerankConfig: LLMConfig = {
    ...embedConfig,
    model: process.env.RERANK_MODEL ?? process.env.LLM_MODEL ?? 'gpt-4o-mini',
  };

  const router = new Router(rerankConfig, embedConfig);
  await router.buildIndex(registry.getAll());

  const executor = new Executor(registry);
  const chatClient = createChatClient(rerankConfig);

  _engine = { registry, router, executor, chatClient };
  return _engine;
}

/** Reset the cached engine (useful in tests). */
export function resetEngine(): void {
  _engine = null;
}
