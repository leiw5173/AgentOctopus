import path from 'path';
import os from 'os';
import { SkillRegistry, syncFromCloud } from '@agentoctopus/registry';
import { Router, Executor, createChatClient, createDefaultSandboxRunner, buildSecretProviderFromConfig, type ChatClient, type LLMConfig, type TelemetryEvent, type TelemetrySink, getConfig, loadConfig } from '@agentoctopus/core';
import { DebugTelemetryBuffer } from './debug-telemetry.js';

export const DIRECT_ANSWER_SYSTEM_PROMPT = 'You are a helpful assistant. Answer the user\'s question concisely and accurately.';

const DEFAULT_HOME = path.join(os.homedir(), '.agentoctopus');

export interface OctopusEngine {
  registry: SkillRegistry;
  router: Router;
  executor: Executor;
  chatClient: ChatClient;
  /** T3.6 aggregator; /agent/debug/last-run queries it. Per-request metadata
   *  (apiKeyId/receivedAt/queryHash) is bound via recordRequestStart called
   *  directly from /ask — NEVER via the shared sink below. */
  telemetryBuffer: DebugTelemetryBuffer;
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

  // T3.7 — shared TelemetrySink → DebugTelemetryBuffer. The sink is SHARED
  // across all requests; per-request ExecutionContext (traceId, apiKeyId,
  // receivedAt) is passed at CALL time (Router.route / Executor.execute) so
  // no per-request state ever lives on the engine's singletons. The buffer
  // ignores events without a traceId, so non-E2E traffic is a no-op.
  const telemetryBuffer = new DebugTelemetryBuffer(config.gateway.debugEndpoints.bufferSize);
  const telemetrySink: TelemetrySink = {
    emit: (e: TelemetryEvent) => telemetryBuffer.record(e, {}),
  };

  const router = new Router(rerankConfig, embedConfig, telemetrySink);
  await router.buildIndex(registry.getAll());

  const chatClient = createChatClient(rerankConfig);
  // Build the host-side secret provider from trusted config and converge the
  // Executor's execution boundary on a runner that provisions credentials ONLY
  // to the trusted egress proxy — never into a prompt, env spec, log, or error.
  const secretProvider = buildSecretProviderFromConfig(config);
  const sandboxRunner = createDefaultSandboxRunner(secretProvider, { telemetrySink });
  const executor = new Executor(registry, chatClient, router, sandboxRunner, { telemetrySink });

  _engine = { registry, router, executor, chatClient, telemetryBuffer };
  return _engine;
}

export function resetEngine(): void {
  _engine = null;
}
