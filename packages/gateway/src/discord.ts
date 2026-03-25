import { Client, GatewayIntentBits, type Message } from 'discord.js';
import { bootstrapEngine } from './engine.js';
import { sessionManager } from './session.js';

export interface DiscordGatewayOptions {
  token: string;
  /** Root directory for engine bootstrap (defaults to OCTOPUS_ROOT or cwd). */
  rootDir?: string;
  /** Respond only when the bot is mentioned (default: true for guilds, false for DMs). */
  requireMention?: boolean;
}

/**
 * Start the Discord bot gateway.
 * Handles message events: responds to DMs always, responds to guild messages
 * only when the bot is mentioned (unless requireMention is false).
 */
export async function startDiscordGateway(options: DiscordGatewayOptions): Promise<void> {
  const engine = await bootstrapEngine(options.rootDir);

  const client = new Client({
    intents: [
      GatewayIntentBits.Guilds,
      GatewayIntentBits.GuildMessages,
      GatewayIntentBits.MessageContent,
      GatewayIntentBits.DirectMessages,
    ],
  });

  client.once('ready', () => {
    console.log(`[Discord Gateway] Logged in as ${client.user?.tag}`);
  });

  client.on('messageCreate', async (message: Message) => {
    if (message.author.bot) return;

    const isDM = !message.guild;
    const isMentioned = client.user ? message.mentions.has(client.user) : false;
    const requireMention = options.requireMention ?? !isDM;

    if (requireMention && !isMentioned && !isDM) return;

    // Strip the bot mention from the text
    const text = message.content.replace(/<@!?\d+>/g, '').trim();
    if (!text) return;

    const channelId = message.channelId;
    const userId = message.author.id;
    const session = sessionManager.getOrCreate(channelId, userId, 'discord');
    sessionManager.addMessage(session, { role: 'user', content: text, timestamp: Date.now() });

    try {
      const [routing] = await engine.router.route(text);
      if (!routing) {
        await message.reply("Sorry, I couldn't find a matching skill for your request.");
        return;
      }

      const result = await engine.executor.execute(routing.skill, { query: text });

      sessionManager.addMessage(session, {
        role: 'assistant',
        content: result.formattedOutput,
        timestamp: Date.now(),
        skillUsed: routing.skill.manifest.name,
      });

      // Discord message limit is 2000 chars
      const reply = result.formattedOutput.slice(0, 1990);
      await message.reply(reply);
    } catch (err) {
      await message.reply(`Error: ${(err as Error).message}`);
    }
  });

  await client.login(options.token);
}
