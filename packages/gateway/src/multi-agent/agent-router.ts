export interface AgentRouteRule {
  agentId: string;
  channelType?: string;
  accountId?: string;
  peerId?: string;
}

/**
 * Maps incoming channel/account/peer combinations to agent IDs.
 * Rules are evaluated in order; the first match wins.
 */
export class AgentRouter {
  private rules: AgentRouteRule[] = [];

  constructor(rules: AgentRouteRule[] = []) {
    this.rules = [...rules];
  }

  addRule(rule: AgentRouteRule): void {
    this.rules.push(rule);
  }

  /**
   * Determine which agent should handle an incoming message.
   * Falls back to the default agent if no rule matches.
   */
  resolveAgentId(
    channelType: string,
    accountId: string,
    peerId: string,
    defaultAgentId?: string,
  ): string | undefined {
    for (const rule of this.rules) {
      const channelMatch = !rule.channelType || rule.channelType === channelType;
      const accountMatch = !rule.accountId || rule.accountId === accountId;
      const peerMatch = !rule.peerId || rule.peerId === peerId;
      if (channelMatch && accountMatch && peerMatch) {
        return rule.agentId;
      }
    }
    return defaultAgentId;
  }

  getRules(): AgentRouteRule[] {
    return [...this.rules];
  }

  static fromConfig(agentsConfig: { entries?: Array<{ id: string; channelType?: string; accountId?: string; peerId?: string }> }): AgentRouter {
    const rules: AgentRouteRule[] = (agentsConfig.entries ?? [])
      .filter((e) => e.channelType || e.accountId || e.peerId)
      .map((e) => ({
        agentId: e.id,
        channelType: e.channelType,
        accountId: e.accountId,
        peerId: e.peerId,
      }));
    return new AgentRouter(rules);
  }
}
