import boltPkg from '@slack/bolt';
const { App } = boltPkg;
type AppOptions = ConstructorParameters<typeof App>[0];
import { bootstrapEngine, type OctopusEngine } from '../engine.js';
import { handleChannelMessage } from './channel-handler.js';
import type { BaseChannel, ChannelReply } from './base-channel.js';

export interface SlackChannelOptions {
  appOptions: AppOptions;
  rootDir?: string;
}

export class SlackChannel implements BaseChannel {
  readonly channelType = 'slack';
  private app: InstanceType<typeof App>;
  private engine!: OctopusEngine;
  private sayMap = new Map<string, (payload: { text: string; thread_ts?: string }) => Promise<unknown>>();

  constructor(private options: SlackChannelOptions) {
    this.app = new App(options.appOptions);
  }

  async start(): Promise<void> {
    this.engine = await bootstrapEngine(this.options.rootDir);

    this.app.event('app_mention', async ({ event, say }) => {
      const text = (event.text ?? '').replace(/<@[^>]+>/g, '').trim();
      const channelId = event.channel;
      const userId = event.user ?? 'unknown';
      const threadTs = event.thread_ts ?? event.ts;
      this.sayMap.set(`${channelId}:${threadTs}`, say);

      const result = await handleChannelMessage(this.engine, {
        text,
        channelId,
        userId,
        platform: 'slack',
      });
      await say({ text: result.text, thread_ts: threadTs });
    });

    this.app.message(async ({ message, say }) => {
      const msg = message as { text?: string; channel?: string; user?: string; ts?: string; thread_ts?: string };
      const text = (msg.text ?? '').trim();
      if (!text) return;
      const channelId = msg.channel ?? 'dm';
      const userId = msg.user ?? 'unknown';
      const threadTs = msg.thread_ts ?? msg.ts;
      this.sayMap.set(`${channelId}:${threadTs}`, say);

      const result = await handleChannelMessage(this.engine, {
        text,
        channelId,
        userId,
        platform: 'slack',
      });
      await say({ text: result.text, thread_ts: threadTs });
    });
  }

  async stop(): Promise<void> {
    // Bolt apps don't have a explicit stop method; rely on process signals
  }

  async send(channelId: string, reply: ChannelReply): Promise<void> {
    const key = reply.threadId ? `${channelId}:${reply.threadId}` : channelId;
    const say = this.sayMap.get(key);
    if (say) {
      await say({ text: reply.text, thread_ts: reply.threadId });
    }
  }
}

/**
 * Legacy convenience function for backward compatibility.
 */
export async function startSlackGateway(options: SlackChannelOptions): Promise<void> {
  const channel = new SlackChannel(options);
  await channel.start();
}
