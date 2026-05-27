import express, { type Request, type Response } from 'express';
import { bootstrapEngine, type OctopusEngine } from '../engine.js';
import { handleChannelMessage } from './channel-handler.js';
import type { BaseChannel, ChannelReply } from './base-channel.js';

export interface WebhookChannelOptions {
  port?: number;
  path?: string;
  secret?: string;
  rootDir?: string;
}

/**
 * Generic HTTP webhook channel.
 * Accepts POST requests with { text, channelId, userId } and responds with JSON.
 */
export class WebhookChannel implements BaseChannel {
  readonly channelType = 'webhook';
  private app = express();
  private server?: ReturnType<typeof this.app.listen>;
  private engine!: OctopusEngine;

  constructor(private options: WebhookChannelOptions) {}

  async start(): Promise<void> {
    this.engine = await bootstrapEngine(this.options.rootDir);
    const port = this.options.port ?? 3005;
    const path = this.options.path ?? '/webhook';

    this.app.use(express.json());

    this.app.post(path, async (req: Request, res: Response) => {
      const secret = req.headers['x-webhook-secret'];
      if (this.options.secret && secret !== this.options.secret) {
        res.status(401).json({ error: 'Invalid secret' });
        return;
      }

      const { text, channelId, userId } = req.body as {
        text?: string;
        channelId?: string;
        userId?: string;
      };

      if (!text || !channelId || !userId) {
        res.status(400).json({ error: 'text, channelId, and userId are required' });
        return;
      }

      const result = await handleChannelMessage(this.engine, {
        text,
        channelId,
        userId,
        platform: 'webhook',
      });

      res.json({
        response: result.text,
        skillUsed: result.skillUsed,
        isError: result.isError,
      });
    });

    return new Promise((resolve) => {
      this.server = this.app.listen(port, () => {
        console.log(`[Webhook Gateway] Listening on port ${port} at ${path}`);
        resolve();
      });
    });
  }

  async stop(): Promise<void> {
    if (this.server) {
      this.server.close();
    }
  }

  async send(_channelId: string, _reply: ChannelReply): Promise<void> {
    // Webhook is request/response; send is not applicable
  }
}
