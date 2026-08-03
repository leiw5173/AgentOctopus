import telegrafPkg from 'telegraf';
const { Telegraf } = telegrafPkg;
type Context = import('telegraf').Context;
import { bootstrapEngine, DIRECT_ANSWER_SYSTEM_PROMPT } from './engine.js';
import { sessionManager } from './session.js';
import { type CredentialMissingResult, type UnsupportedRuntimeRequirementsResult } from '@agentoctopus/core';

function isCredentialMissing(result: unknown): result is CredentialMissingResult {
  return typeof result === 'object' && result !== null && 'type' in result && (result as { type: string }).type === 'credential_missing';
}

function isUnsupportedRuntime(result: unknown): result is UnsupportedRuntimeRequirementsResult {
  return typeof result === 'object' && result !== null && 'type' in result && (result as { type: string }).type === 'unsupported_runtime_requirements';
}

export interface TelegramGatewayOptions {
  token: string;
  /** Root directory for engine bootstrap (defaults to OCTOPUS_ROOT or cwd). */
  rootDir?: string;
}

/**
 * Start the Telegram bot gateway.
 * Handles text messages and /ask commands via long-polling.
 */
export async function startTelegramGateway(options: TelegramGatewayOptions): Promise<void> {
  const engine = await bootstrapEngine(options.rootDir);
  const bot = new Telegraf(options.token);

  async function handleText(ctx: Context, text: string) {
    const channelId = String(ctx.chat?.id ?? 'unknown');
    const userId = String(ctx.from?.id ?? 'unknown');
    const session = sessionManager.getOrCreate(channelId, userId, 'telegram');
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
        await ctx.reply(answer.slice(0, 4096));
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
        await ctx.reply(`I matched a skill but it needs an unconfigured API key:\n${lines}${setupCmd}`);
        return;
      }

      if (isUnsupportedRuntime(result)) {
        const tools = result.missing.map(b => `  - ${b}`).join('\n');
        await ctx.reply(`I matched a skill but it requires tools that aren't installed:\n${tools}\n\nNo trusted runtime profile covers: ${result.missing.join(', ')}. Ask the operator to add one under \`sandbox.runtimeProfiles\`.`);
        return;
      }

      const execResult = result as import('@agentoctopus/core').ExecutionResult;

      sessionManager.addMessage(session, {
        role: 'assistant',
        content: execResult.formattedOutput,
        timestamp: Date.now(),
        skillUsed: routing.skill.manifest.name,
      });

      // Telegram limit is 4096 chars
      await ctx.reply(execResult.formattedOutput.slice(0, 4096));
    } catch (err) {
      await ctx.reply(`Error: ${(err as Error).message}`);
    }
  }

  // /ask command: /ask translate hello to French
  bot.command('ask', async (ctx) => {
    const text = ctx.message.text.replace(/^\/ask\s*/i, '').trim();
    if (!text) {
      await ctx.reply('Usage: /ask <your request>');
      return;
    }
    await handleText(ctx, text);
  });

  // Plain text messages
  bot.on('text', async (ctx) => {
    const text = ctx.message.text.trim();
    if (!text || text.startsWith('/')) return;
    await handleText(ctx, text);
  });

  await bot.launch();
  console.log('[Telegram Gateway] Bot launched (long-polling)');

  // Graceful stop
  process.once('SIGINT', () => bot.stop('SIGINT'));
  process.once('SIGTERM', () => bot.stop('SIGTERM'));
}
