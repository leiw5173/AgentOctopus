export type GatewayEvent =
  | { type: 'message-received'; channelType: string; channelId: string; userId: string; text: string }
  | { type: 'skill-executed'; skillName: string; success: boolean; latencyMs: number; agentId?: string }
  | { type: 'feedback-recorded'; skillName: string; positive: boolean; source: string; agentId?: string }
  | { type: 'session-created'; sessionId: string; channelId: string; userId: string; agentId?: string }
  | { type: 'session-expired'; sessionId: string; agentId?: string };

export type EventListener = (event: GatewayEvent) => void;

/**
 * Typed pub/sub event bus for cross-component communication.
 * All gateway components publish events here; interested parties subscribe.
 */
export class EventBus {
  private listeners = new Map<string, Set<EventListener>>();

  on(eventType: GatewayEvent['type'], listener: EventListener): () => void {
    if (!this.listeners.has(eventType)) {
      this.listeners.set(eventType, new Set());
    }
    this.listeners.get(eventType)!.add(listener);
    return () => this.listeners.get(eventType)?.delete(listener);
  }

  emit(event: GatewayEvent): void {
    const set = this.listeners.get(event.type);
    if (!set) return;
    for (const listener of set) {
      try {
        listener(event);
      } catch {
        // Event listener failures must not crash the bus
      }
    }
  }
}

export const eventBus = new EventBus();
