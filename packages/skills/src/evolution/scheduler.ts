import fs from 'fs';
import path from 'path';
import { getSignalsSince } from './collector.js';

export function shouldSweep(lastSweepAt: string | null, sweepIntervalMs: number): boolean {
  if (!lastSweepAt) return true;
  return Date.now() - new Date(lastSweepAt).getTime() > sweepIntervalMs;
}

export function getStaleSkills(skillsDir: string, staleCutoff: string): string[] {
  if (!fs.existsSync(skillsDir)) return [];

  const entries = fs.readdirSync(skillsDir, { withFileTypes: true });
  const stale: string[] = [];

  for (const entry of entries) {
    if (!entry.isDirectory() || entry.name.startsWith('.')) continue;

    const skillPath = path.join(skillsDir, entry.name);
    const skillMd = path.join(skillPath, 'SKILL.md');
    if (!fs.existsSync(skillMd)) continue;

    const evolutionDir = path.join(skillPath, '.evolution');
    const signals = getSignalsSince(evolutionDir, staleCutoff);

    if (signals.length === 0) {
      stale.push(entry.name);
    }
  }

  return stale;
}
