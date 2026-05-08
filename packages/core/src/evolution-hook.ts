import path from 'path';
import { recordSignal, countSignalsSince, countNegativeFeedbackSince } from '@agentoctopus/skills';
import { getConfig } from './config-resolver.js';

export function recordExecutionSignal(
  skillDirPath: string,
  success: boolean,
  latencyMs: number,
  tokenUsage: number,
  error: string | null,
): void {
  const config = getConfig().evolution;
  if (!config.enabled) return;

  const evolutionDir = path.join(skillDirPath, '.evolution');
  recordSignal(evolutionDir, {
    type: 'invocation',
    success,
    latencyMs,
    tokenUsage,
    error,
  });
}

export function shouldTriggerAnalysis(skillDirPath: string, lastAnalysisAt: string): boolean {
  const config = getConfig().evolution;
  if (!config.enabled) return false;

  const evolutionDir = path.join(skillDirPath, '.evolution');

  const total = countSignalsSince(evolutionDir, lastAnalysisAt);
  if (total >= config.signalThreshold) return true;

  const negative = countNegativeFeedbackSince(evolutionDir, lastAnalysisAt);
  if (negative >= config.feedbackThreshold) return true;

  return false;
}
