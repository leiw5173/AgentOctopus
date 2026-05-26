import type { AgentConfigSection } from '@agentoctopus/core';
import { createAgentInstance, type AgentInstance } from './agent-instance.js';

export interface AgentPoolOptions {
  globalConfig: { gateway: { cloudUrl?: string | null; syncOnStartup?: boolean } };
}

/**
 * Manages multiple isolated agent instances.
 * Each agent has its own workspace, skill registry, router, executor, and sessions.
 */
export class AgentPool {
  private agents = new Map<string, AgentInstance>();

  constructor(private options: AgentPoolOptions) {}

  async addAgent(config: AgentConfigSection): Promise<AgentInstance> {
    const instance = await createAgentInstance(config, this.options.globalConfig);
    this.agents.set(config.id, instance);
    console.log(`[AgentPool] Agent "${instance.name}" (${config.id}) initialized`);
    return instance;
  }

  async initAgents(configs: AgentConfigSection[]): Promise<void> {
    for (const config of configs) {
      await this.addAgent(config);
    }
  }

  getAgent(id: string): AgentInstance | undefined {
    return this.agents.get(id);
  }

  getDefaultAgent(): AgentInstance | undefined {
    const first = this.agents.values().next().value;
    return first;
  }

  listAgents(): Array<{ id: string; name: string; workspaceDir: string }> {
    return Array.from(this.agents.values()).map((a) => ({
      id: a.id,
      name: a.name,
      workspaceDir: a.workspaceDir,
    }));
  }

  removeAgent(id: string): boolean {
    return this.agents.delete(id);
  }
}
