import { sessionManager } from '../session.js';
import { DIRECT_ANSWER_SYSTEM_PROMPT } from '../engine.js';
import type { OctopusEngine } from '../engine.js';
import type { ChannelMessage, ChannelReply } from './base-channel.js';
import { type CredentialMissingResult, type BinaryMissingResult, type BinaryInstallableResult, type BinaryInstallFailedResult } from '@agentoctopus/core';

function isCredentialMissing(result: unknown): result is CredentialMissingResult {
  return typeof result === 'object' && result !== null && 'type' in result && (result as { type: string }).type === 'credential_missing';
}

function isBinaryMissing(result: unknown): result is BinaryMissingResult {
  return typeof result === 'object' && result !== null && 'type' in result && (result as { type: string }).type === 'binary_missing';
}

function isBinaryInstallable(result: unknown): result is BinaryInstallableResult {
  return typeof result === 'object' && result !== null && 'type' in result && (result as { type: string }).type === 'binary_installable';
}

function isBinaryInstallFailed(result: unknown): result is BinaryInstallFailedResult {
  return typeof result === 'object' && result !== null && 'type' in result && (result as { type: string }).type === 'binary_install_failed';
}

function isInstallConfirmation(text: string): boolean {
  return /^\s*(yes|y|ok|install|sure|go ahead|confirm)\s*$/i.test(text.trim());
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
    // Two-phase: if user confirmed a pending install, auto-install and retry
    const pending = session.metadata?.pendingInstall as { skill: unknown; query: string } | undefined;
    if (pending && isInstallConfirmation(text)) {
      delete (session.metadata as Record<string, unknown>).pendingInstall;
      const skill = pending.skill as Parameters<typeof engine.executor.execute>[0];
      const installResult = await engine.executor.execute(skill, { query: pending.query }, { autoInstall: true });

      if (isBinaryInstallFailed(installResult)) {
        const instructions = (installResult.manualInstructions as string[]).map(i => `  ${i}`).join('\n');
        return { text: `Installation failed. Install manually:\n${instructions}`, isError: true };
      }

      if (!isBinaryMissing(installResult) && !isBinaryInstallable(installResult) && !isCredentialMissing(installResult)) {
        const execResult = installResult as import('@agentoctopus/core').ExecutionResult;
        sessionManager.addMessage(session, {
          role: 'assistant',
          content: execResult.formattedOutput,
          timestamp: Date.now(),
          skillUsed: skill.manifest?.name,
        });
        return { text: execResult.formattedOutput, skillUsed: skill.manifest?.name };
      }
    }

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

    if (isBinaryInstallable(result)) {
      const tools = (result.missing as string[]).map(b => `  - ${b}`).join('\n');
      (session.metadata as Record<string, unknown>).pendingInstall = { skill: routing.skill, query: text };
      return {
        text: `I matched a skill but it requires tools that aren't installed:\n${tools}\n\nReply "yes" to install automatically, or install them manually.`,
        isError: true,
      };
    }

    if (isBinaryMissing(result)) {
      const tools = result.missing.map(b => `  - ${b}`).join('\n');
      return {
        text: `I matched a skill but it requires tools that aren't installed:\n${tools}\n\nInstall the tool(s) above, then retry.`,
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
