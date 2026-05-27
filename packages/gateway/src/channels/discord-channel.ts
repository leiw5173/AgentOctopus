import { Client, GatewayIntentBits, type Message } from 'discord.js';
import { bootstrapEngine, type OctopusEngine } from '../engine.js';
import { handleChannelMessage } from './channel-handler.js';
import type { BaseChannel, ChannelReply } from './base-channel.js';

export interface DiscordChannelOptions {
  token: string;
  rootDir?: string;
  requireMention?: boolean;
}

export class DiscordChannel implements BaseChannel {
  readonly channelType = 'discord';
  private client: Client;
  private engine!: OctopusEngine;

  constructor(private options: DiscordChannelOptions) {
    this.client = new Client({
      intents: [
        GatewayIntentBits.Guilds,
        GatewayIntentBits.GuildMessages,
        GatewayIntentBits.MessageContent,
        GatewayIntentBits.DirectMessages,
      ],
    });
  }

  async start(): Promise<void> {
    this.engine = await bootstrapEngine(this.options.rootDir);

    this.client.once('ready', () => {
      console.log(`[Discord Gateway] Logged in as ${this.client.user?.tag}`);
    });

    this.client.on('messageCreate', async (message: Message) => {
      if (message.author.bot) return;

      const isDM = !message.guild;
      const isMentioned = this.client.user ? message.mentions.has(this.client.user) : false;
      const requireMention = this.options.requireMention ?? !isDM;

      if (requireMention && !isMentioned && !isDM) return;

      const text = message.content.replace(/<@!?\d+>/g, '').trim();
      if (!text) return;

      const result = await handleChannelMessage(this.engine, {
        text,
        channelId: message.channelId,
        userId: message.author.id,
        platform: 'discord',
      });

      await message.reply(result.text.slice(0, 1990));
    });

    await this.client.login(this.options.token);
  }

  async stop(): Promise<void> {
    this.client.destroy();
  }

  async send(channelId: string, reply: ChannelReply): Promise<void> {
    const channel = await this.client.channels.fetch(channelId);
    if (channel && 'send' in channel) {
      await (channel as any).send(reply.text.slice(0, 1990));
    }
  }
}

/**
 * Legacy convenience function for backward compatibility.
 */
export async function startDiscordGateway(options: DiscordChannelOptions): Promise<void> {
  const channel = new DiscordChannel(options);
  await channel.start();
}
