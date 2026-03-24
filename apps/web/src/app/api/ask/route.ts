import { NextResponse } from 'next/server';
import { Router, Executor } from '@octopus/core';
import { SkillRegistry } from '@octopus/registry';
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

async function initOctopus() {
  if (!isInitialized) {
    await registry.load();
    const llmConfig = {
      provider: (process.env.LLM_PROVIDER as 'openai' | 'gemini' | 'ollama') || 'openai',
      model: process.env.LLM_MODEL || 'gpt-4o',
    };
    
    // In advanced setups, embed config could be separated based on ENV.
    router = new Router(llmConfig, llmConfig);
    await router.buildIndex(registry.getAll());
    executor = new Executor(registry);
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
    if (!routes || routes.length === 0) {
      return NextResponse.json({ error: 'No suitable skill found' }, { status: 404 });
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
