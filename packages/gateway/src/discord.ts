import { Client, GatewayIntentBits, type Message } from 'discord.js';
import { bootstrapEngine, DIRECT_ANSWER_SYSTEM_PROMPT } from './engine.js';
import { sessionManager } from './session.js';
import { type CredentialMissingResult, type BinaryMissingResult } from '@agentoctopus/core';

function isCredentialMissing(result: unknown): result is CredentialMissingResult {
  return typeof result === 'object' && result !== null && 'type' in result && (result as { type: string }).type === 'credential_missing';
}

function isBinaryMissing(result: unknown): result is BinaryMissingResult {
  return typeof result === 'object' && result !== null && 'type' in result && (result as { type: string }).type === 'binary_missing';
}

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
        const answer = await engine.chatClient.chat(DIRECT_ANSWER_SYSTEM_PROMPT, text);
        sessionManager.addMessage(session, {
          role: 'assistant',
          content: answer,
          timestamp: Date.now(),
        });
        await message.reply(answer.slice(0, 1990));
        return;
      }

      const result = await engine.executor.execute(routing.skill, { query: text });

      // Handle credential missing
      if (isCredentialMissing(result)) {
        const lines = result.missing
          .map(v => `  - ${v.key}${v.label ? ` — ${v.label}` : ''}`)
          .join('\n');
        const setupCmd = result.missing[0]?.key
          ? `\nRun: octopus config set ${result.missing[0].key} <your-key>`
          : '';
        await message.reply(`I matched a skill but it needs an unconfigured API key:\n${lines}${setupCmd}`);
        return;
      }

      if (isBinaryMissing(result)) {
        const tools = result.missing.map(b => `  - ${b}`).join('\n');
        await message.reply(`I matched a skill but it requires tools that aren't installed:\n${tools}\n\nInstall the tool(s) above, then retry.`);
        return;
      }

      const execResult = result as import('@agentoctopus/core').ExecutionResult;

      sessionManager.addMessage(session, {
        role: 'assistant',
        content: execResult.formattedOutput,
        timestamp: Date.now(),
        skillUsed: routing.skill.manifest.name,
      });

      // Discord message limit is 2000 chars
      const reply = execResult.formattedOutput.slice(0, 1990);
      await message.reply(reply);
    } catch (err) {
      await message.reply(`Error: ${(err as Error).message}`);
    }
  });

  await client.login(options.token);
}
