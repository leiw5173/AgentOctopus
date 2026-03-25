import { NextResponse } from 'next/server';
import { Router, Executor, createChatClient } from '@agentoctopus/core';
import { SkillRegistry } from '@agentoctopus/registry';
import path from 'path';

// Singleton initialization for production (can be expanded for persistence)
const registry = new SkillRegistry(
  path.resolve(process.cwd(), '../../registry/skills'),
  path.resolve(process.cwd(), '../../registry/ratings.json')
);

// We keep a simple memo to avoid rebuilding index on every request
let isInitialized = false;
let router: Router;
let executor: Executor;
let chatClient: ReturnType<typeof createChatClient>;

async function initOctopus() {
  if (!isInitialized) {
    await registry.load();

    const chatConfig = {
      provider: (process.env.LLM_PROVIDER as 'openai' | 'gemini' | 'ollama') ?? 'openai',
      model: process.env.LLM_MODEL ?? 'gpt-4o',
      apiKey: process.env.OPENAI_API_KEY ?? process.env.GEMINI_API_KEY,
      baseUrl: process.env.OPENAI_BASE_URL ?? process.env.OLLAMA_BASE_URL,
    };

    const embedConfig = {
      provider: (process.env.EMBED_PROVIDER as 'openai' | 'gemini' | 'ollama') ?? chatConfig.provider,
      model: process.env.EMBED_MODEL ?? 'text-embedding-3-small',
      apiKey: process.env.EMBED_API_KEY ?? chatConfig.apiKey,
      baseUrl: process.env.EMBED_BASE_URL ?? chatConfig.baseUrl,
    };

    // Use embed provider for chat re-ranking if the primary chat endpoint is unreachable
    const rerankConfig = {
      ...embedConfig,
      model: process.env.RERANK_MODEL ?? process.env.LLM_MODEL ?? 'gpt-4o-mini',
    };

    router = new Router(rerankConfig, embedConfig);
    await router.buildIndex(registry.getAll());
    executor = new Executor(registry);
    chatClient = createChatClient(rerankConfig);
    isInitialized = true;
  }
}

export async function POST(req: Request) {
  try {
    const { query } = await req.json();
    if (!query) {
      return NextResponse.json({ error: 'Query is missing' }, { status: 400 });
    }

    await initOctopus();

    const routes = await router.route(query);

    // No skill matched — answer directly with the LLM
    if (!routes || routes.length === 0) {
      const answer = await chatClient.chat(
        'You are a helpful assistant. Answer the user\'s question concisely and accurately.',
        query,
      );
      return NextResponse.json({
        success: true,
        skill: null,
        confidence: null,
        rating: null,
        response: answer,
      });
    }

    const bestMatch = routes[0];
    const { skill, adapterResult, formattedOutput } = await executor.execute(bestMatch.skill, { query });

    return NextResponse.json({
      success: true,
      skill: skill.manifest.name,
      rating: skill.rating,
      confidence: bestMatch.score,
      adapterOutput: adapterResult,
      response: formattedOutput,
    });
  } catch (error: any) {
    return NextResponse.json({ error: error.message }, { status: 500 });
  }
}
