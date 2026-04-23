import { NextResponse } from 'next/server';
import { Router, Executor, createChatClient, type CredentialMissingResult, type BinaryMissingResult } from '@agentoctopus/core';
import { SkillRegistry } from '@agentoctopus/registry';
import path from 'path';

function isCredentialMissing(result: unknown): result is CredentialMissingResult {
  return typeof result === 'object' && result !== null && 'type' in result && (result as { type: string }).type === 'credential_missing';
}

function isBinaryMissing(result: unknown): result is BinaryMissingResult {
  return typeof result === 'object' && result !== null && 'type' in result && (result as { type: string }).type === 'binary_missing';
}

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

    // Try up to 3 candidates on execution failure
    const maxRetries = 3;
    const candidates = routes.slice(0, maxRetries);
    const skillsAttempted: string[] = [];
    const executionErrors: string[] = [];

    for (let i = 0; i < candidates.length; i++) {
      const route = candidates[i]!;
      skillsAttempted.push(route.skill.manifest.name);
      try {
        const result = await executor.execute(route.skill, { query });

        if (isCredentialMissing(result)) {
          return NextResponse.json({
            success: false,
            type: 'credential_missing',
            skillName: result.skillName,
            missing: result.missing,
            skillsAttempted,
            response: `This skill needs an unconfigured API key. Run: octopus config set ${result.missing[0]?.key ?? 'KEY'} <your-key>`,
          });
        }

        if (isBinaryMissing(result)) {
          return NextResponse.json({
            success: false,
            type: 'binary_missing',
            skillName: result.skillName,
            missing: result.missing,
            skillsAttempted,
            response: `This skill requires tools that aren't installed: ${result.missing.join(', ')}. Install them, then retry.`,
          });
        }

        const { skill, adapterResult, formattedOutput } = result;
        if (adapterResult.success) {
          return NextResponse.json({
            success: true,
            skill: skill.manifest.name,
            rating: skill.rating,
            confidence: route.score,
            adapterOutput: adapterResult,
            skillsAttempted,
            response: formattedOutput,
          });
        }
        // Failed — record error and try next candidate
        executionErrors.push(adapterResult.error ?? 'unknown error');
      } catch (err) {
        executionErrors.push(err instanceof Error ? err.message : String(err));
      }
    }

    // All candidates failed — fall back to direct LLM answer
    const answer = await chatClient.chat(
      'You are a helpful assistant. Answer the user\'s question concisely and accurately.',
      query,
    );
    return NextResponse.json({
      success: true,
      skill: null,
      confidence: null,
      rating: null,
      skillsAttempted,
      fallbackReason: `All ${skillsAttempted.length} skill(s) failed`,
      ...(process.env.NODE_ENV !== 'production' ? { executionErrors } : {}),
      response: answer,
    });
  } catch (error: unknown) {
    const message = error instanceof Error ? error.message : String(error);
    return NextResponse.json({ error: message }, { status: 500 });
  }
}
