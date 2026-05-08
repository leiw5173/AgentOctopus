import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import fs from 'fs';
import path from 'path';
import os from 'os';
import { shadowCopy, listSnapshots, rollback, clearSnapshots } from '../../src/evolution/rollback.js';

describe('shadowCopy', () => {
  let tmpDir: string;
  let skillFilePath: string;
  let evolutionDir: string;

  beforeEach(() => {
    tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'evolve-rollback-'));
    skillFilePath = path.join(tmpDir, 'SKILL.md');
    evolutionDir = path.join(tmpDir, '.evolution');
    fs.writeFileSync(skillFilePath, '# Original content\n', 'utf8');
  });

  afterEach(() => {
    fs.rmSync(tmpDir, { recursive: true, force: true });
  });

  it('creates a snapshot of SKILL.md in history/', () => {
    shadowCopy(skillFilePath, evolutionDir, 20);

    const historyDir = path.join(evolutionDir, 'history');
    const files = fs.readdirSync(historyDir);
    expect(files).toHaveLength(1);
    expect(files[0]).toMatch(/^\d{4}-\d{2}-\d{2}T\d{2}/);
    expect(files[0]).toMatch(/\.md$/);

    const snapshot = fs.readFileSync(path.join(historyDir, files[0]), 'utf8');
    expect(snapshot).toBe('# Original content\n');
  });

  it('limits snapshots to maxHistorySnapshots', () => {
    // Create 5 snapshots with limit of 3
    for (let i = 0; i < 5; i++) {
      fs.writeFileSync(skillFilePath, `# Content ${i}\n`, 'utf8');
      shadowCopy(skillFilePath, evolutionDir, 3);
    }

    const files = listSnapshots(evolutionDir);
    expect(files).toHaveLength(3);
    // Should have the 3 most recent
    const contents = files.map((f) => fs.readFileSync(path.join(evolutionDir, 'history', f), 'utf8'));
    expect(contents).toEqual(['# Content 2\n', '# Content 3\n', '# Content 4\n']);
  });
});

describe('rollback', () => {
  let tmpDir: string;
  let skillFilePath: string;
  let evolutionDir: string;

  beforeEach(() => {
    tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'evolve-rollback-op-'));
    skillFilePath = path.join(tmpDir, 'SKILL.md');
    evolutionDir = path.join(tmpDir, '.evolution');

    // Create 3 versions
    fs.writeFileSync(skillFilePath, '# V1\n', 'utf8');
    shadowCopy(skillFilePath, evolutionDir, 20);

    fs.writeFileSync(skillFilePath, '# V2\n', 'utf8');
    shadowCopy(skillFilePath, evolutionDir, 20);

    fs.writeFileSync(skillFilePath, '# V3\n', 'utf8');
    shadowCopy(skillFilePath, evolutionDir, 20);
  });

  afterEach(() => {
    fs.rmSync(tmpDir, { recursive: true, force: true });
  });

  it('restores the most recent snapshot by default', () => {
    rollback(skillFilePath, evolutionDir);

    const restored = fs.readFileSync(skillFilePath, 'utf8');
    expect(restored).toBe('# V2\n');
  });

  it('restores a specific snapshot by index', () => {
    rollback(skillFilePath, evolutionDir, 0);

    const restored = fs.readFileSync(skillFilePath, 'utf8');
    expect(restored).toBe('# V1\n');
  });

  it('saves current state as snapshot before rollback', () => {
    rollback(skillFilePath, evolutionDir);

    const files = listSnapshots(evolutionDir);
    // Should now have 4: 3 originals + 1 from the rollback save
    expect(files).toHaveLength(4);
    const lastSnapshot = fs.readFileSync(path.join(evolutionDir, 'history', files[files.length - 1]), 'utf8');
    expect(lastSnapshot).toBe('# V3\n'); // the state before rollback
  });

  it('throws when no snapshots exist', () => {
    const freshDir = path.join(tmpDir, 'fresh');
    const freshSkill = path.join(freshDir, 'SKILL.md');
    const freshEvo = path.join(freshDir, '.evolution');
    fs.mkdirSync(freshDir, { recursive: true });
    fs.writeFileSync(freshSkill, '# content\n', 'utf8');

    expect(() => rollback(freshSkill, freshEvo)).toThrow('No snapshots available');
  });

  it('throws when snapshot index out of range', () => {
    expect(() => rollback(skillFilePath, evolutionDir, 99)).toThrow('Snapshot index 99 out of range');
  });
});

describe('listSnapshots', () => {
  it('returns empty array when no history dir', () => {
    const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'evolve-list-'));
    const result = listSnapshots(path.join(tmpDir, 'nonexistent'));
    expect(result).toEqual([]);
    fs.rmSync(tmpDir, { recursive: true, force: true });
  });
});
