import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import fs from 'fs';
import path from 'path';
import os from 'os';
import { shouldSweep, getStaleSkills } from '../../src/evolution/scheduler.js';

describe('shouldSweep', () => {
  it('returns true when lastSweepAt is too old', () => {
    const sevenDaysAgo = new Date(Date.now() - 7 * 24 * 3600 * 1000).toISOString();
    // Stale check interval is 1 day (24 hours)
    expect(shouldSweep(sevenDaysAgo, 24 * 3600 * 1000)).toBe(true);
  });

  it('returns false when lastSweepAt is recent', () => {
    const oneHourAgo = new Date(Date.now() - 3600 * 1000).toISOString();
    expect(shouldSweep(oneHourAgo, 24 * 3600 * 1000)).toBe(false);
  });

  it('returns true when lastSweepAt is null (never swept)', () => {
    expect(shouldSweep(null, 24 * 3600 * 1000)).toBe(true);
  });
});

describe('getStaleSkills', () => {
  let tmpDir: string;

  beforeEach(() => {
    tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'evolve-stale-'));
  });

  afterEach(() => {
    fs.rmSync(tmpDir, { recursive: true, force: true });
  });

  it('returns skills not invoked since cutoff', () => {
    // Create skills dir with two skills
    fs.mkdirSync(path.join(tmpDir, 'skill-a'), { recursive: true });
    fs.mkdirSync(path.join(tmpDir, 'skill-b'), { recursive: true });
    fs.writeFileSync(path.join(tmpDir, 'skill-a', 'SKILL.md'), '---\nname: skill-a\ndescription: A\n---\n\n# A');
    fs.writeFileSync(path.join(tmpDir, 'skill-b', 'SKILL.md'), '---\nname: skill-b\ndescription: B\n---\n\n# B');

    // Cutoff: 1 second in the past (signals after this are considered recent)
    const cutoff = new Date(Date.now() - 1000).toISOString();

    // Create signals.jsonl for skill-b (recent invocation, after cutoff)
    fs.mkdirSync(path.join(tmpDir, 'skill-b', '.evolution'), { recursive: true });
    fs.writeFileSync(
      path.join(tmpDir, 'skill-b', '.evolution', 'signals.jsonl'),
      JSON.stringify({ ts: new Date().toISOString(), type: 'invocation', success: true, latencyMs: 100, tokenUsage: 50 }) + '\n',
    );

    // skill-a has no signals → never invoked → stale
    // skill-b has signals after cutoff → not stale
    const stale = getStaleSkills(tmpDir, cutoff);
    expect(stale).toHaveLength(1);
    expect(stale[0]).toBe('skill-a');
  });

  it('ignores non-directories and files starting with dot', () => {
    fs.mkdirSync(path.join(tmpDir, 'valid-skill'), { recursive: true });
    fs.writeFileSync(path.join(tmpDir, 'valid-skill', 'SKILL.md'), '---\nname: valid\ndescription: x\n---\n\n# X');
    fs.writeFileSync(path.join(tmpDir, 'not-a-skill.txt'), 'garbage');
    fs.mkdirSync(path.join(tmpDir, '.hidden'), { recursive: true });

    const stale = getStaleSkills(tmpDir, new Date().toISOString());
    expect(stale).toContain('valid-skill');
    expect(stale).not.toContain('not-a-skill.txt');
    expect(stale).not.toContain('.hidden');
  });

  it('returns empty array when dir does not exist', () => {
    const result = getStaleSkills(path.join(tmpDir, 'nope'), new Date().toISOString());
    expect(result).toEqual([]);
  });
});
