import type { AgentConfigSection } from '@agentoctopus/core';
import { isPaired, generatePairingCode, validatePairingCode } from './pairing-store.js';

export type DMPolicyResult = 'allow' | 'block' | 'pairing_required' | 'pairing_code_sent';

export interface DMPolicyContext {
  peerId: string;
  channelType: string;
  isDM: boolean;
  text: string;
}

/**
 * Evaluate DM security policy for an incoming message.
 *
 * Policy modes:
 *   - "pairing" (default): Unknown senders receive a pairing code challenge.
 *                          Messages are dropped until they reply with the code.
 *   - "open": All messages are allowed. Explicit opt-in required in config.
 */
export function evaluateDMPolicy(
  ctx: DMPolicyContext,
  policy: AgentConfigSection['dmPolicy'],
): DMPolicyResult {
  // Only apply DM policy to direct messages
  if (!ctx.isDM) return 'allow';

  if (policy === 'open') {
    return 'allow';
  }

  // Pairing mode (default)
  if (isPaired(ctx.peerId, ctx.channelType)) {
    return 'allow';
  }

  // Check if the message is a pairing code response
  const trimmed = ctx.text.trim();
  if (/^[A-F0-9]{6}$/i.test(trimmed)) {
    if (validatePairingCode(ctx.peerId, trimmed)) {
      return 'allow';
    }
  }

  // Send pairing challenge
  const code = generatePairingCode(ctx.peerId, ctx.channelType);
  return 'pairing_code_sent';
}
