import telegrafPkg from 'telegraf';
const { Telegraf } = telegrafPkg;
type Context = import('telegraf').Context;
import { bootstrapEngine, type OctopusEngine } from '../engine.js';
import { handleChannelMessage } from './channel-handler.js';
import type { BaseChannel, ChannelReply } from './base-channel.js';

export interface TelegramChannelOptions {
  token: string;
  rootDir?: string;
}

export class TelegramChannel implements BaseChannel {
  readonly channelType = 'telegram';
  private bot: InstanceType<typeof Telegraf>;
  private engine!: OctopusEngine;

  constructor(private options: TelegramChannelOptions) {
    this.bot = new Telegraf(options.token);
  }

  async start(): Promise<void> {
    this.engine = await bootstrapEngine(this.options.rootDir);

    const handleText = async (ctx: Context, text: string) => {
      const channelId = String(ctx.chat?.id ?? 'unknown');
      const userId = String(ctx.from?.id ?? 'unknown');

      const result = await handleChannelMessage(this.engine, {
        text,
        channelId,
        userId,
        platform: 'telegram',
      });

      await ctx.reply(result.text.slice(0, 4096));
    };

    this.bot.command('ask', async (ctx) => {
      const text = ctx.message.text.replace(/^\/ask\s*/i, '').trim();
      if (!text) {
        await ctx.reply('Usage: /ask <your request>');
        return;
      }
      await handleText(ctx, text);
    });

    this.bot.on('text', async (ctx) => {
      const text = ctx.message.text.trim();
      if (!text || text.startsWith('/')) return;
      await handleText(ctx, text);
    });

    await this.bot.launch();
    console.log('[Telegram Gateway] Bot launched (long-polling)');

    process.once('SIGINT', () => this.bot.stop('SIGINT'));
    process.once('SIGTERM', () => this.bot.stop('SIGTERM'));
  }

  async stop(): Promise<void> {
    this.bot.stop();
  }

  async send(channelId: string, reply: ChannelReply): Promise<void> {
    await this.bot.telegram.sendMessage(channelId, reply.text.slice(0, 4096));
  }
}

/**
 * Legacy convenience function for backward compatibility.
 */
export async function startTelegramGateway(options: TelegramChannelOptions): Promise<void> {
  const channel = new TelegramChannel(options);
  await channel.start();
}
