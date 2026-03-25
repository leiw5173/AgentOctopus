import { v4 as uuidv4 } from 'uuid';

export interface SessionMessage {
  role: 'user' | 'assistant';
  content: string;
  timestamp: number;
  skillUsed?: string;
}

export interface Session {
  id: string;
  channelId: string;
  userId: string;
  platform: 'slack' | 'discord' | 'telegram' | 'agent' | 'http';
  messages: SessionMessage[];
  createdAt: number;
  updatedAt: number;
  metadata: Record<string, unknown>;
}

const SESSION_TTL_MS = 30 * 60 * 1000; // 30 minutes

export class SessionManager {
  private sessions: Map<string, Session> = new Map();

  /** Get or create a session for the given channel + user on a platform. */
  getOrCreate(channelId: string, userId: string, platform: Session['platform']): Session {
    const key = this.makeKey(channelId, userId, platform);
    let session = this.sessions.get(key);

    if (!session || this.isExpired(session)) {
      session = {
        id: uuidv4(),
        channelId,
        userId,
        platform,
        messages: [],
        createdAt: Date.now(),
        updatedAt: Date.now(),
        metadata: {},
      };
      this.sessions.set(key, session);
    }

    return session;
  }

  /** Append a message to a session and update the timestamp. */
  addMessage(session: Session, message: SessionMessage): void {
    session.messages.push(message);
    session.updatedAt = Date.now();
    // Keep last 50 messages to avoid unbounded growth
    if (session.messages.length > 50) {
      session.messages.splice(0, session.messages.length - 50);
    }
  }

  /** Retrieve a session by its unique ID. */
  getById(sessionId: string): Session | undefined {
    for (const session of this.sessions.values()) {
      if (session.id === sessionId) return session;
    }
    return undefined;
  }

  /** Manually expire a session. */
  destroy(channelId: string, userId: string, platform: Session['platform']): void {
    const key = this.makeKey(channelId, userId, platform);
    this.sessions.delete(key);
  }

  /** Purge all sessions that have exceeded the TTL. */
  prune(): void {
    for (const [key, session] of this.sessions.entries()) {
      if (this.isExpired(session)) {
        this.sessions.delete(key);
      }
    }
  }

  private makeKey(channelId: string, userId: string, platform: string): string {
    return `${platform}:${channelId}:${userId}`;
  }

  private isExpired(session: Session): boolean {
    return Date.now() - session.updatedAt > SESSION_TTL_MS;
  }
}

/** Singleton instance shared across gateway adapters. */
export const sessionManager = new SessionManager();
