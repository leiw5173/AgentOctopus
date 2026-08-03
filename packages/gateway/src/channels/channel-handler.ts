import { sessionManager } from '../session.js';
import { DIRECT_ANSWER_SYSTEM_PROMPT } from '../engine.js';
import type { OctopusEngine } from '../engine.js';
import type { ChannelMessage, ChannelReply } from './base-channel.js';
import { type CredentialMissingResult, type UnsupportedRuntimeRequirementsResult } from '@agentoctopus/core';

function isCredentialMissing(result: unknown): result is CredentialMissingResult {
  return typeof result === 'object' && result !== null && 'type' in result && (result as { type: string }).type === 'credential_missing';
}

function isUnsupportedRuntime(result: unknown): result is UnsupportedRuntimeRequirementsResult {
  return typeof result === 'object' && result !== null && 'type' in result && (result as { type: string }).type === 'unsupported_runtime_requirements';
}

export interface HandlerResult {
  text: string;
  skillUsed?: string;
  isError?: boolean;
}

/**
 * Shared message handling logic for all channels.
 * Routes the query, executes the skill, and returns formatted reply text.
 */
export async function handleChannelMessage(
  engine: OctopusEngine,
  message: ChannelMessage,
): Promise<HandlerResult> {
  const { text, channelId, userId, platform } = message;
  const session = sessionManager.getOrCreate(channelId, userId, platform as any);
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
      return { text: answer };
    }

    const result = await engine.executor.execute(routing.skill, { query: text });

    if (isCredentialMissing(result)) {
      const lines = result.missing
        .map(v => `  - ${v.key}${v.label ? ` — ${v.label}` : ''}`)
        .join('\n');
      const setupCmd = result.missing[0]?.key
        ? `\nRun: octopus config set ${result.missing[0].key} <your-key>`
        : '';
      return {
        text: `I matched a skill but it needs an unconfigured API key:\n${lines}${setupCmd}`,
        isError: true,
      };
    }

    if (isUnsupportedRuntime(result)) {
      const tools = result.missing.map(b => `  - ${b}`).join('\n');
      return {
        text: `I matched a skill but it requires tools that aren't installed:\n${tools}\n\nNo trusted runtime profile covers: ${result.missing.join(', ')}. Ask the operator to add one under \`sandbox.runtimeProfiles\`.`,
        isError: true,
      };
    }

    const execResult = result as import('@agentoctopus/core').ExecutionResult;

    sessionManager.addMessage(session, {
      role: 'assistant',
      content: execResult.formattedOutput,
      timestamp: Date.now(),
      skillUsed: routing.skill.manifest.name,
    });

    return { text: execResult.formattedOutput, skillUsed: routing.skill.manifest.name };
  } catch (err) {
    return { text: `Error: ${(err as Error).message}`, isError: true };
  }
}
