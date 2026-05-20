import { bootstrapEngine, type OctopusEngine } from '../engine.js';
import { handleChannelMessage } from './channel-handler.js';
import type { BaseChannel, ChannelReply } from './base-channel.js';

export interface WebchatChannelOptions {
  port?: number;
  rootDir?: string;
}

interface WebchatMessage {
  type: 'message';
  text: string;
  channelId: string;
  userId: string;
}

interface WebchatResponse {
  type: 'response';
  text: string;
  skillUsed?: string;
  isError?: boolean;
}

interface WsSocket {
  on(event: string, listener: (data: Buffer) => void): void;
  send(data: string): void;
  readyState: number;
}

interface WsServer {
  on(event: string, handler: (ws: WsSocket) => void): void;
  close(): void;
}

/**
 * WebSocket-based WebChat channel for browser clients.
 * Uses lazy import of 'ws' to avoid hard dependency.
 */
export class WebchatChannel implements BaseChannel {
  readonly channelType = 'webchat';
  private wss?: WsServer;
  private engine!: OctopusEngine;
  private sockets = new Map<string, WsSocket>();

  constructor(private options: WebchatChannelOptions) {}

  async start(): Promise<void> {
    this.engine = await bootstrapEngine(this.options.rootDir);
    const port = this.options.port ?? 3006;

    // Lazy import ws to avoid hard dependency at type-check time
    const wsMod = await import('ws' as any);
    const WebSocketServer = wsMod.WebSocketServer || wsMod.default?.WebSocketServer;
    this.wss = new WebSocketServer({ port }) as WsServer;

    this.wss.on('connection', (ws: WsSocket) => {
      ws.on('message', async (data: Buffer) => {
        try {
          const msg = JSON.parse(data.toString()) as WebchatMessage;
          if (msg.type !== 'message') return;

          this.sockets.set(`${msg.channelId}:${msg.userId}`, ws);

          const result = await handleChannelMessage(this.engine, {
            text: msg.text,
            channelId: msg.channelId,
            userId: msg.userId,
            platform: 'webchat',
          });

          const response: WebchatResponse = {
            type: 'response',
            text: result.text,
            skillUsed: result.skillUsed,
            isError: result.isError,
          };
          ws.send(JSON.stringify(response));
        } catch {
          ws.send(JSON.stringify({ type: 'error', text: 'Invalid message format' }));
        }
      });
    });

    console.log(`[Webchat Gateway] WebSocket server on port ${port}`);
  }

  async stop(): Promise<void> {
    this.wss?.close();
  }

  async send(channelId: string, reply: ChannelReply): Promise<void> {
    const OPEN = 1; // WebSocket.OPEN constant
    for (const [key, ws] of this.sockets) {
      if (key.startsWith(`${channelId}:`) && ws.readyState === OPEN) {
        ws.send(JSON.stringify({ type: 'response', text: reply.text }));
      }
    }
  }
}
