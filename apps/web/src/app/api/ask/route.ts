import { NextResponse } from 'next/server';
import { Router, Executor, createChatClient, loadConfig, type CredentialMissingResult, type BinaryMissingResult, type BinaryInstallableResult, type BinaryInstallFailedResult } from '@agentoctopus/core';
import { SkillRegistry } from '@agentoctopus/registry';
import path from 'path';

function isCredentialMissing(result: unknown): result is CredentialMissingResult {
  return typeof result === 'object' && result !== null && 'type' in result && (result as { type: string }).type === 'credential_missing';
}

function isBinaryMissing(result: unknown): result is BinaryMissingResult {
  return typeof result === 'object' && result !== null && 'type' in result && (result as { type: string }).type === 'binary_missing';
}

function isBinaryInstallable(result: unknown): result is BinaryInstallableResult {
  return typeof result === 'object' && result !== null && 'type' in result && (result as { type: string }).type === 'binary_installable';
}

function isBinaryInstallFailed(result: unknown): result is BinaryInstallFailedResult {
  return typeof result === 'object' && result !== null && 'type' in result && (result as { type: string }).type === 'binary_install_failed';
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
    const config = loadConfig();

    await registry.load();

    const chatConfig = {
      provider: config.llm.provider,
      model: config.llm.model,
      apiKey: config.llm.apiKey || undefined,
      baseUrl: config.llm.baseUrl,
    };

    const embedConfig = {
      provider: config.embed.provider,
      model: config.embed.model,
      apiKey: config.embed.apiKey || chatConfig.apiKey,
      baseUrl: config.embed.baseUrl || chatConfig.baseUrl,
    };

    const rerankConfig = {
      ...embedConfig,
      model: config.rerank.model,
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
    const { query, autoInstall = false } = await req.json();
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
        const result = await executor.execute(route.skill, { query }, { autoInstall });

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

        if (isBinaryInstallable(result)) {
          return NextResponse.json({
            success: false,
            type: 'binary_installable',
            skillName: result.skillName,
            missing: result.missing,
            installSpecs: result.installSpecs,
            skillsAttempted,
            response: `This skill requires tools that aren't installed: ${(result.missing as string[]).join(', ')}. Retry with autoInstall=true to install automatically.`,
          });
        }

        if (isBinaryInstallFailed(result)) {
          return NextResponse.json({
            success: false,
            type: 'binary_install_failed',
            skillName: result.skillName,
            missing: result.missing,
            manualInstructions: result.manualInstructions,
            skillsAttempted,
            response: `Installation failed. Manual steps:\n${(result.manualInstructions as string[]).map(i => `  ${i}`).join('\n')}`,
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
