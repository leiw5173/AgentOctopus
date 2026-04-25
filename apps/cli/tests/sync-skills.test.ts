import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import fs from 'fs';
import path from 'path';
import os from 'os';
import { checkSkillUpdates, applySkillUpdates, installAwesomeSkills } from '../src/sync-skills.js';
import type { SkillUpdate } from '../src/sync-skills.js';
import { gzipSync } from 'zlib';

function makeIndexGz(skills: unknown[]): Buffer {
  const json = JSON.stringify({ version: '1', builtAt: '2026-01-01T00:00:00Z', skills });
  return gzipSync(Buffer.from(json));
}

describe('checkSkillUpdates', () => {
  let fetchSpy: ReturnType<typeof vi.spyOn>;
  let tmpDir: string;

  beforeEach(() => {
    fetchSpy = vi.spyOn(globalThis, 'fetch');
    tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'octopus-sync-test-'));
  });

  afterEach(() => {
    fetchSpy.mockRestore();
    fs.rmSync(tmpDir, { recursive: true });
  });

  it('returns empty array when skills dir does not exist', async () => {
    const result = await checkSkillUpdates(path.join(tmpDir, 'nonexistent'));
    expect(result).toEqual([]);
  });

  it('returns empty array when index download fails', async () => {
    fetchSpy.mockResolvedValueOnce({ ok: false, status: 500 } as Response);
    const result = await checkSkillUpdates(tmpDir);
    expect(result).toEqual([]);
  });

  it('detects skills with available updates', async () => {
    // Create an installed skill with version 1.0.0
    const skillDir = path.join(tmpDir, 'my-skill');
    fs.mkdirSync(skillDir, { recursive: true });
    fs.writeFileSync(
      path.join(skillDir, 'SKILL.md'),
      '---\nname: my-skill\nversion: 1.0.0\n---\n\n# My Skill',
    );

    // Mock the skills index with version 2.0.0
    const skills = [
      {
        slug: 'my-skill',
        name: 'My Skill',
        description: 'desc',
        version: '2.0.0',
        author: 'bob',
        skillMd: '---\nname: my-skill\nversion: 2.0.0\n---\n\n# My Skill v2',
        metaJson: '{}',
        invokeScript: null,
      },
    ];
    const gz = makeIndexGz(skills);
    fetchSpy.mockResolvedValueOnce({
      ok: true,
      status: 200,
      arrayBuffer: async () => gz.buffer.slice(gz.byteOffset, gz.byteOffset + gz.byteLength),
    } as unknown as Response);

    const result = await checkSkillUpdates(tmpDir);
    expect(result).toHaveLength(1);
    expect(result[0]!.slug).toBe('my-skill');
    expect(result[0]!.currentVersion).toBe('1.0.0');
    expect(result[0]!.latestVersion).toBe('2.0.0');
  });

  it('skips skills that are already up to date', async () => {
    const skillDir = path.join(tmpDir, 'my-skill');
    fs.mkdirSync(skillDir, { recursive: true });
    fs.writeFileSync(
      path.join(skillDir, 'SKILL.md'),
      '---\nname: my-skill\nversion: 2.0.0\n---\n\n# My Skill',
    );

    const skills = [
      {
        slug: 'my-skill',
        name: 'My Skill',
        description: 'desc',
        version: '2.0.0',
        author: 'bob',
        skillMd: '---\nname: my-skill\nversion: 2.0.0\n---',
        metaJson: '{}',
        invokeScript: null,
      },
    ];
    const gz = makeIndexGz(skills);
    fetchSpy.mockResolvedValueOnce({
      ok: true,
      status: 200,
      arrayBuffer: async () => gz.buffer.slice(gz.byteOffset, gz.byteOffset + gz.byteLength),
    } as unknown as Response);

    const result = await checkSkillUpdates(tmpDir);
    expect(result).toHaveLength(0);
  });

  it('skips skills without a version in frontmatter', async () => {
    const skillDir = path.join(tmpDir, 'my-skill');
    fs.mkdirSync(skillDir, { recursive: true });
    fs.writeFileSync(
      path.join(skillDir, 'SKILL.md'),
      '---\nname: my-skill\n---\n\n# My Skill',
    );

    const skills = [
      {
        slug: 'my-skill',
        name: 'My Skill',
        description: 'desc',
        version: '1.0.0',
        author: 'bob',
        skillMd: '---\nname: my-skill\nversion: 1.0.0\n---',
        metaJson: '{}',
        invokeScript: null,
      },
    ];
    const gz = makeIndexGz(skills);
    fetchSpy.mockResolvedValueOnce({
      ok: true,
      status: 200,
      arrayBuffer: async () => gz.buffer.slice(gz.byteOffset, gz.byteOffset + gz.byteLength),
    } as unknown as Response);

    const result = await checkSkillUpdates(tmpDir);
    expect(result).toHaveLength(0);
  });
});

describe('applySkillUpdates', () => {
  let tmpDir: string;

  beforeEach(() => {
    tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'octopus-sync-apply-'));
  });

  afterEach(() => {
    fs.rmSync(tmpDir, { recursive: true });
  });

  it('updates skills by re-installing from index entries', () => {
    // Create an old skill
    const skillDir = path.join(tmpDir, 'my-skill');
    fs.mkdirSync(skillDir, { recursive: true });
    fs.writeFileSync(path.join(skillDir, 'SKILL.md'), '---\nname: my-skill\nversion: 1.0.0\n---');

    const updates: SkillUpdate[] = [
      { slug: 'my-skill', currentVersion: '1.0.0', latestVersion: '2.0.0' },
    ];

    const indexEntries = [
      {
        slug: 'my-skill',
        name: 'My Skill',
        description: 'desc',
        version: '2.0.0',
        author: 'bob',
        skillMd: '---\nname: my-skill\nversion: 2.0.0\n---\n\n# v2',
        metaJson: '{}',
        invokeScript: null,
      },
    ];

    const updated = applySkillUpdates(updates, tmpDir, indexEntries as any);
    expect(updated).toEqual(['my-skill']);
    expect(fs.readFileSync(path.join(tmpDir, 'my-skill', 'SKILL.md'), 'utf8')).toContain('2.0.0');
  });

  it('skips updates when slug is not in index', () => {
    const updates: SkillUpdate[] = [
      { slug: 'missing-skill', currentVersion: '1.0.0', latestVersion: '2.0.0' },
    ];

    const updated = applySkillUpdates(updates, tmpDir, []);
    expect(updated).toEqual([]);
  });
});

describe('installAwesomeSkills — deleted', () => {
  let fetchSpy: ReturnType<typeof vi.spyOn>;
  let tmpDir: string;

  beforeEach(() => {
    fetchSpy = vi.spyOn(globalThis, 'fetch');
    tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'octopus-sync-del-'));
  });

  afterEach(() => {
    fetchSpy.mockRestore();
    fs.rmSync(tmpDir, { recursive: true });
  });

  it('deletes local skills not present in the index', async () => {
    // Create a stale local skill
    const staleDir = path.join(tmpDir, 'stale-skill');
    fs.mkdirSync(staleDir, { recursive: true });
    fs.writeFileSync(path.join(staleDir, 'SKILL.md'), '---\nname: stale-skill\nversion: 1.0.0\n---');

    // Index with only one skill — NOT stale-skill
    const skills = [
      {
        slug: 'good-skill',
        name: 'Good Skill',
        description: 'desc',
        version: '1.0.0',
        author: 'alice',
        skillMd: '---\nname: good-skill\nversion: 1.0.0\n---\n\n# Good',
        metaJson: '{}',
        invokeScript: null,
        scripts: null,
        files: null,
      },
    ];
    const gz = makeIndexGz(skills);
    fetchSpy.mockResolvedValueOnce({
      ok: true,
      status: 200,
      arrayBuffer: async () => gz.buffer.slice(gz.byteOffset, gz.byteOffset + gz.byteLength),
    } as unknown as Response);

    const result = await installAwesomeSkills({
      skillsDir: tmpDir,
      force: false,
    });

    expect(result.deleted).toBe(1);
    expect(fs.existsSync(staleDir)).toBe(false);
    expect(fs.existsSync(path.join(tmpDir, 'good-skill'))).toBe(true);
  });
});
