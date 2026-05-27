import path from 'path';
import os from 'os';
import { SkillRegistry, syncFromCloud } from '@agentoctopus/registry';
import { Router, Executor, createChatClient, type ChatClient, type LLMConfig } from '@agentoctopus/core';
import { SessionManager } from '../session.js';
import type { AgentConfigSection } from '@agentoctopus/core';

export interface AgentInstance {
  id: string;
  name: string;
  config: AgentConfigSection;
  registry: SkillRegistry;
  router: Router;
  executor: Executor;
  chatClient: ChatClient;
  sessionManager: SessionManager;
  workspaceDir: string;
}

const DEFAULT_HOME = path.join(os.homedir(), '.agentoctopus');

export async function createAgentInstance(
  agentConfig: AgentConfigSection,
  globalConfig: { gateway: { cloudUrl?: string | null; syncOnStartup?: boolean } },
): Promise<AgentInstance> {
  const id = agentConfig.id;
  const name = agentConfig.name ?? id;
  const workspaceDir = agentConfig.workspace
    ? path.resolve(agentConfig.workspace)
    : path.join(DEFAULT_HOME, 'agents', id, 'workspace');

  const skillsDir = path.join(workspaceDir, 'skills');
  const ratingsPath = path.join(workspaceDir, 'ratings.json');

  // Cloud sync for agent workspace
  if (globalConfig.gateway.cloudUrl && globalConfig.gateway.syncOnStartup) {
    try {
      const result = await syncFromCloud(globalConfig.gateway.cloudUrl, skillsDir);
      const total = result.added.length + result.updated.length;
      if (total > 0) {
        console.log(`[Agent:${id}] Synced ${total} skill(s) from cloud`);
      }
    } catch (err) {
      console.warn(`[Agent:${id}] Startup sync failed: ${(err as Error).message}`);
    }
  }

  const registry = new SkillRegistry(skillsDir, ratingsPath);
  await registry.load();

  // Use agent-specific model config if provided, else global
  const modelConfig = agentConfig.model ?? {};
  const chatConfig: LLMConfig = {
    provider: (modelConfig.provider as any) ?? 'openai',
    model: modelConfig.model ?? 'gpt-4o',
    apiKey: modelConfig.apiKey || undefined,
    baseUrl: modelConfig.baseUrl,
  };

  const router = new Router(chatConfig);
  await router.buildIndex(registry.getAll());

  const chatClient = createChatClient(chatConfig);
  const executor = new Executor(registry, chatClient);
  const sessionManager = new SessionManager();

  return {
    id,
    name,
    config: agentConfig,
    registry,
    router,
    executor,
    chatClient,
    sessionManager,
    workspaceDir,
  };
}
