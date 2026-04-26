import boltPkg from '@slack/bolt';
const { App } = boltPkg;
type AppOptions = ConstructorParameters<typeof App>[0];
import { bootstrapEngine, DIRECT_ANSWER_SYSTEM_PROMPT } from './engine.js';
import { sessionManager } from './session.js';
import { getConfig, type CredentialMissingResult, type BinaryMissingResult } from '@agentoctopus/core';

function isCredentialMissing(result: unknown): result is CredentialMissingResult {
  return typeof result === 'object' && result !== null && 'type' in result && (result as { type: string }).type === 'credential_missing';
}

function isBinaryMissing(result: unknown): result is BinaryMissingResult {
  return typeof result === 'object' && result !== null && 'type' in result && (result as { type: string }).type === 'binary_missing';
}

export interface SlackGatewayOptions {
  appOptions: AppOptions;
  /** Root directory for engine bootstrap (defaults to OCTOPUS_ROOT or cwd). */
  rootDir?: string;
}

/**
 * Start the Slack bot gateway.
 * Listens for app_mention and direct message events, routes them through
 * the OctopusEngine, and replies in the same thread/channel.
 */
export async function startSlackGateway(options: SlackGatewayOptions): Promise<void> {
  const engine = await bootstrapEngine(options.rootDir);
  const app = new App(options.appOptions);

  async function handleMessage({
    text,
    channelId,
    userId,
    say,
    threadTs,
  }: {
    text: string;
    channelId: string;
    userId: string;
    say: (payload: { text: string; thread_ts?: string }) => Promise<unknown>;
    threadTs?: string;
  }) {
    const session = sessionManager.getOrCreate(channelId, userId, 'slack');
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
        await say({ text: answer, thread_ts: threadTs });
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
        await say({ text: `I matched a skill but it needs an unconfigured API key:\n${lines}${setupCmd}`, thread_ts: threadTs });
        return;
      }

      if (isBinaryMissing(result)) {
        const tools = result.missing.map(b => `  - ${b}`).join('\n');
        await say({ text: `I matched a skill but it requires tools that aren't installed:\n${tools}\n\nInstall the tool(s) above, then retry.`, thread_ts: threadTs });
        return;
      }

      const execResult = result as import('@agentoctopus/core').ExecutionResult;

      sessionManager.addMessage(session, {
        role: 'assistant',
        content: execResult.formattedOutput,
        timestamp: Date.now(),
        skillUsed: routing.skill.manifest.name,
      });

      await say({ text: execResult.formattedOutput, thread_ts: threadTs });
    } catch (err) {
      await say({ text: `Error: ${(err as Error).message}`, thread_ts: threadTs });
    }
  }

  // Handle @mentions
  app.event('app_mention', async ({ event, say }) => {
    const text = (event.text ?? '').replace(/<@[^>]+>/g, '').trim();
    await handleMessage({
      text,
      channelId: event.channel,
      userId: event.user ?? 'unknown',
      say,
      threadTs: event.thread_ts ?? event.ts,
    });
  });

  // Handle direct messages
  app.message(async ({ message, say }) => {
    const msg = message as { text?: string; channel?: string; user?: string; ts?: string; thread_ts?: string };
    const text = (msg.text ?? '').trim();
    if (!text) return;
    await handleMessage({
      text,
      channelId: msg.channel ?? 'dm',
      userId: msg.user ?? 'unknown',
      say,
      threadTs: msg.thread_ts ?? msg.ts,
    });
  });

  const port = getConfig().slack.port;
  await app.start(port);
  console.log(`[Slack Gateway] Listening on port ${port}`);
}
