import fs from 'fs';
import path from 'path';
import type { EvolutionSignal } from './types.js';

export function recordSignal(evolutionDir: string, signal: Omit<EvolutionSignal, 'ts'> & { ts?: string }): void {
  const full: EvolutionSignal = { ts: new Date().toISOString(), ...signal } as EvolutionSignal;

  fs.mkdirSync(evolutionDir, { recursive: true });

  const filePath = path.join(evolutionDir, 'signals.jsonl');
  fs.appendFileSync(filePath, JSON.stringify(full) + '\n', 'utf8');
}

export function getSignalsSince(evolutionDir: string, since: string): EvolutionSignal[] {
  const filePath = path.join(evolutionDir, 'signals.jsonl');
  if (!fs.existsSync(filePath)) return [];

  const lines = fs.readFileSync(filePath, 'utf8').trim().split('\n').filter(Boolean);
  return lines
    .map((line) => {
      try {
        return JSON.parse(line) as EvolutionSignal;
      } catch {
        return null;
      }
    })
    .filter((s): s is EvolutionSignal => s !== null && s.ts >= since);
}

export function countSignalsSince(evolutionDir: string, since: string): number {
  return getSignalsSince(evolutionDir, since).length;
}

export function countNegativeFeedbackSince(evolutionDir: string, since: string): number {
  return getSignalsSince(evolutionDir, since).filter(
    (s) => s.type === 'feedback' && s.positive === false,
  ).length;
}
