import { getConfig } from '@agentoctopus/core';
import { AgentPool } from '../multi-agent/agent-pool.js';
import { AgentRouter } from '../multi-agent/agent-router.js';
import { eventBus, type GatewayEvent } from './event-bus.js';
import type { BaseChannel } from '../channels/base-channel.js';
import type { AgentInstance } from '../multi-agent/agent-instance.js';

export interface ControlPlaneOptions {
  rootDir?: string;
}

/**
 * The Gateway Control Plane is the single control center for sessions, channels,
 * tools, and events. It routes incoming events to the correct agent instance.
 */
export class ControlPlane {
  private agentPool: AgentPool;
  private agentRouter: AgentRouter;
  private channels = new Map<string, BaseChannel>();
  private started = false;

  constructor(private options: ControlPlaneOptions = {}) {
    const config = getConfig();
    this.agentPool = new AgentPool({ globalConfig: config as any });
    this.agentRouter = AgentRouter.fromConfig(config.agents);
  }

  async start(): Promise<void> {
    if (this.started) return;
    const config = getConfig();

    // Initialize agents from config
    const agentEntries = config.agents.entries ?? [];
    if (agentEntries.length === 0) {
      // Create a default agent if none configured
      await this.agentPool.addAgent({
        id: 'default',
        name: 'Default Agent',
        dmPolicy: 'pairing',
      });
    } else {
      await this.agentPool.initAgents(agentEntries);
    }

    this.started = true;
    console.log('[ControlPlane] Started with', this.agentPool.listAgents().length, 'agent(s)');
  }

  async stop(): Promise<void> {
    for (const channel of this.channels.values()) {
      await channel.stop();
    }
    this.channels.clear();
    this.started = false;
  }

  registerChannel(channel: BaseChannel): void {
    this.channels.set(channel.channelType, channel);
  }

  getChannel(type: string): BaseChannel | undefined {
    return this.channels.get(type);
  }

  /**
   * Route an incoming event to the appropriate agent.
   */
  async routeEvent(event: GatewayEvent): Promise<void> {
    eventBus.emit(event);

    if (event.type !== 'message-received') return;

    const agentId = this.agentRouter.resolveAgentId(
      event.channelType,
      event.channelId,
      event.userId,
      getConfig().agents.default ?? 'default',
    );

    const agent = agentId ? this.agentPool.getAgent(agentId) : this.agentPool.getDefaultAgent();
    if (!agent) {
      console.warn(`[ControlPlane] No agent found for event: ${event.channelType}:${event.channelId}`);
      return;
    }

    // The channel handler (in channel-handler.ts) already does routing/execution.
    // The control plane's role is agent selection + event distribution.
    // Actual message processing happens at the channel level using the agent's engine.
  }

  getAgent(agentId: string): AgentInstance | undefined {
    return this.agentPool.getAgent(agentId);
  }

  getDefaultAgent(): AgentInstance | undefined {
    return this.agentPool.getDefaultAgent();
  }

  listAgents(): Array<{ id: string; name: string; workspaceDir: string }> {
    return this.agentPool.listAgents();
  }

  async addAgent(config: { id: string; name?: string; model?: any; workspace?: string; dmPolicy?: 'pairing' | 'open' }): Promise<AgentInstance> {
    return this.agentPool.addAgent(config as any);
  }
}

let _controlPlane: ControlPlane | null = null;

export async function getControlPlane(options?: ControlPlaneOptions): Promise<ControlPlane> {
  if (!_controlPlane) {
    _controlPlane = new ControlPlane(options);
    await _controlPlane.start();
  }
  return _controlPlane;
}

export function resetControlPlane(): void {
  _controlPlane = null;
}
