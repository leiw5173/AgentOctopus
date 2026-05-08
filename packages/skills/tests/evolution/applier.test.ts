import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import fs from 'fs';
import path from 'path';
import os from 'os';
import { applyChanges, stageProposal, readProposal } from '../../src/evolution/applier.js';
import type { EvolutionProposal } from '../../src/evolution/types.js';

const sampleProposal: EvolutionProposal = {
  skillName: 'test-skill',
  skillDirPath: '', // set per test
  generatedAt: '2026-05-08T10:00:00Z',
  evidence: 'completion dropped from 0.9 to 0.5',
  changes: [
    {
      field: 'description',
      risk: 'safe',
      original: 'Get weather data.',
      proposed: 'Get current weather, forecasts, and astronomical data for any city worldwide.',
      rationale: 'Add keywords for better matching',
    },
    {
      field: 'instructions',
      risk: 'risky',
      original: 'Call curl wttr.in/city',
      proposed: 'Call curl -s "wttr.in/$(encodeURIComponent(city))"',
      rationale: 'Add URL encoding and silent flag',
    },
  ],
};

describe('applyChanges', () => {
  let tmpDir: string;
  let skillFilePath: string;
  let evolutionDir: string;
  let proposal: EvolutionProposal;

  beforeEach(() => {
    tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'evolve-applier-'));
    skillFilePath = path.join(tmpDir, 'SKILL.md');
    evolutionDir = path.join(tmpDir, '.evolution');

    const frontmatter = [
      '---',
      'name: test-skill',
      'description: Get weather data.',
      '---',
      '',
      '# Test Skill',
      '',
      'Call curl wttr.in/city',
    ].join('\n');

    fs.writeFileSync(skillFilePath, frontmatter, 'utf8');

    proposal = { ...sampleProposal, skillDirPath: tmpDir };
  });

  afterEach(() => {
    fs.rmSync(tmpDir, { recursive: true, force: true });
  });

  it('auto-applies safe changes to SKILL.md', () => {
    const safeOnly: EvolutionProposal = { ...proposal, changes: [proposal.changes[0]] };
    const result = applyChanges(safeOnly);

    expect(result.applied).toBe(1);
    expect(result.staged).toBe(0);

    const content = fs.readFileSync(skillFilePath, 'utf8');
    expect(content).toContain('Get current weather, forecasts, and astronomical data for any city worldwide.');
  });

  it('stages risky changes as proposal.md', () => {
    const riskyOnly: EvolutionProposal = { ...proposal, changes: [proposal.changes[1]] };
    const result = applyChanges(riskyOnly);

    expect(result.applied).toBe(0);
    expect(result.staged).toBe(1);
    expect(fs.readFileSync(skillFilePath, 'utf8')).toContain('Get weather data.'); // unchanged

    const stagedPath = path.join(evolutionDir, 'proposal.md');
    expect(fs.existsSync(stagedPath)).toBe(true);
    const staged = fs.readFileSync(stagedPath, 'utf8');
    expect(staged).toContain('risk: risky');
    expect(staged).toContain('Add URL encoding and silent flag');
  });

  it('creates shadow copy before applying safe changes', () => {
    const safeOnly: EvolutionProposal = { ...proposal, changes: [proposal.changes[0]] };
    applyChanges(safeOnly);

    const historyDir = path.join(evolutionDir, 'history');
    expect(fs.existsSync(historyDir)).toBe(true);
    const snapshots = fs.readdirSync(historyDir).filter((f) => f.endsWith('.md'));
    expect(snapshots.length).toBe(1);
    const content = fs.readFileSync(path.join(historyDir, snapshots[0]), 'utf8');
    expect(content).toContain('description: Get weather data.'); // original
  });

  it('returns zero applied for empty changes', () => {
    const result = applyChanges({ ...proposal, changes: [] });
    expect(result.applied).toBe(0);
    expect(result.staged).toBe(0);
  });
});

describe('stageProposal / readProposal', () => {
  it('writes and reads proposal as markdown', () => {
    const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'evolve-proposal-'));
    const evolutionDir = path.join(tmpDir, '.evolution');

    stageProposal(evolutionDir, sampleProposal);

    const read = readProposal(evolutionDir);
    expect(read).not.toBeNull();
    expect(read!.skillName).toBe('test-skill');
    expect(read!.changes).toHaveLength(2);

    fs.rmSync(tmpDir, { recursive: true, force: true });
  });
});
