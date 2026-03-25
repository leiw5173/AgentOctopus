import path from 'path';
import { SkillRegistry } from '@octopus/registry';
import { Router, Executor, type LLMConfig } from '@octopus/core';

export interface OctopusEngine {
  registry: SkillRegistry;
  router: Router;
  executor: Executor;
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

  const router = new Router(chatConfig, embedConfig);
  await router.buildIndex(registry.getAll());

  const executor = new Executor(registry);

  _engine = { registry, router, executor };
  return _engine;
}

/** Reset the cached engine (useful in tests). */
export function resetEngine(): void {
  _engine = null;
}
