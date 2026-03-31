import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import fs from 'fs';
import path from 'path';
import os from 'os';
import { syncFromCloud, type SkillExportResponse } from '../src/sync.js';

describe('syncFromCloud', () => {
  let tmpDir: string;

  beforeEach(() => {
    tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'octopus-sync-'));
    vi.restoreAllMocks();
  });

  afterEach(() => {
    fs.rmSync(tmpDir, { recursive: true, force: true });
  });

  const makeExportResponse = (
    skills: SkillExportResponse['skills'] = [],
  ): SkillExportResponse => ({
    skills,
    exportedAt: new Date().toISOString(),
  });

  it('syncs new skills to local directory', async () => {
    const payload = makeExportResponse([
      {
        name: 'test-skill',
        version: '1.0.0',
        skillMd: '---\nname: test-skill\nversion: 1.0.0\n---\nInstructions here',
        scripts: { 'invoke.js': 'console.log("hello")' },
      },
    ]);

    vi.spyOn(globalThis, 'fetch').mockResolvedValue({
      ok: true,
      json: async () => payload,
    } as Response);

    const result = await syncFromCloud('http://cloud:3002', tmpDir);

    expect(result.added).toEqual(['test-skill']);
    expect(result.updated).toEqual([]);
    expect(result.skipped).toEqual([]);
    expect(result.errors).toEqual([]);

    // Verify files were written
    const skillMd = fs.readFileSync(path.join(tmpDir, 'test-skill', 'SKILL.md'), 'utf-8');
    expect(skillMd).toContain('name: test-skill');

    const script = fs.readFileSync(path.join(tmpDir, 'test-skill', 'scripts', 'invoke.js'), 'utf-8');
    expect(script).toBe('console.log("hello")');
  });

  it('skips existing skills with same version', async () => {
    // Pre-create a local skill
    const skillDir = path.join(tmpDir, 'existing-skill');
    fs.mkdirSync(skillDir, { recursive: true });
    fs.writeFileSync(
      path.join(skillDir, 'SKILL.md'),
      '---\nname: existing-skill\nversion: 1.0.0\n---\nLocal instructions',
    );

    const payload = makeExportResponse([
      {
        name: 'existing-skill',
        version: '1.0.0',
        skillMd: '---\nname: existing-skill\nversion: 1.0.0\n---\nRemote instructions',
        scripts: {},
      },
    ]);

    vi.spyOn(globalThis, 'fetch').mockResolvedValue({
      ok: true,
      json: async () => payload,
    } as Response);

    const result = await syncFromCloud('http://cloud:3002', tmpDir);

    expect(result.skipped).toEqual(['existing-skill']);
    expect(result.added).toEqual([]);

    // Local content should be unchanged
    const skillMd = fs.readFileSync(path.join(skillDir, 'SKILL.md'), 'utf-8');
    expect(skillMd).toContain('Local instructions');
  });

  it('force-overwrites existing skills', async () => {
    const skillDir = path.join(tmpDir, 'existing-skill');
    fs.mkdirSync(skillDir, { recursive: true });
    fs.writeFileSync(
      path.join(skillDir, 'SKILL.md'),
      '---\nname: existing-skill\nversion: 1.0.0\n---\nLocal instructions',
    );

    const payload = makeExportResponse([
      {
        name: 'existing-skill',
        version: '1.0.0',
        skillMd: '---\nname: existing-skill\nversion: 1.0.0\n---\nRemote instructions',
        scripts: {},
      },
    ]);

    vi.spyOn(globalThis, 'fetch').mockResolvedValue({
      ok: true,
      json: async () => payload,
    } as Response);

    const result = await syncFromCloud('http://cloud:3002', tmpDir, true);

    expect(result.updated).toEqual(['existing-skill']);

    const skillMd = fs.readFileSync(path.join(skillDir, 'SKILL.md'), 'utf-8');
    expect(skillMd).toContain('Remote instructions');
  });

  it('updates skills when remote version is newer', async () => {
    const skillDir = path.join(tmpDir, 'versioned-skill');
    fs.mkdirSync(skillDir, { recursive: true });
    fs.writeFileSync(
      path.join(skillDir, 'SKILL.md'),
      '---\nname: versioned-skill\nversion: 1.0.0\n---\nOld instructions',
    );

    const payload = makeExportResponse([
      {
        name: 'versioned-skill',
        version: '2.0.0',
        skillMd: '---\nname: versioned-skill\nversion: 2.0.0\n---\nNew instructions',
        scripts: {},
      },
    ]);

    vi.spyOn(globalThis, 'fetch').mockResolvedValue({
      ok: true,
      json: async () => payload,
    } as Response);

    const result = await syncFromCloud('http://cloud:3002', tmpDir);

    expect(result.updated).toEqual(['versioned-skill']);

    const skillMd = fs.readFileSync(path.join(skillDir, 'SKILL.md'), 'utf-8');
    expect(skillMd).toContain('New instructions');
  });

  it('throws on fetch failure', async () => {
    vi.spyOn(globalThis, 'fetch').mockResolvedValue({
      ok: false,
      status: 500,
      statusText: 'Internal Server Error',
    } as Response);

    await expect(syncFromCloud('http://cloud:3002', tmpDir)).rejects.toThrow(
      'Failed to fetch skill export',
    );
  });

  it('handles empty skill list', async () => {
    vi.spyOn(globalThis, 'fetch').mockResolvedValue({
      ok: true,
      json: async () => makeExportResponse([]),
    } as Response);

    const result = await syncFromCloud('http://cloud:3002', tmpDir);

    expect(result.added).toEqual([]);
    expect(result.skipped).toEqual([]);
    expect(result.errors).toEqual([]);
  });
});
