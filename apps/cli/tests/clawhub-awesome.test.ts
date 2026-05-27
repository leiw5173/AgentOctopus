import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { fetchAwesomeSlugs, downloadSkillsIndex, installFromIndex } from '../src/clawhub.js';
import fs from 'fs';
import path from 'path';
import os from 'os';
import { gzipSync } from 'zlib';

// Sample markdown that mirrors the real category file format
const SAMPLE_MARKDOWN = `
# Git & GitHub Skills

- [git-commit-ai](https://clawskills.sh/skills/acme-git-commit-ai) - AI-powered commit messages.
- [github-pr-review](https://clawskills.sh/skills/octodev-github-pr-review) - Review pull requests.
- [repo-stats](https://clawskills.sh/skills/statbot-repo-stats) - Show repo statistics.
`;

const SAMPLE_README = `
## Categories

- [Git & GitHub](categories/git-and-github.md)
- [Coding Agents](categories/coding-agents-and-ides.md)
`;

function makeIndexGz(skills: unknown[]): Buffer {
  const json = JSON.stringify({ version: '1', builtAt: '2026-01-01T00:00:00Z', skills });
  return gzipSync(Buffer.from(json));
}

describe('fetchAwesomeSlugs', () => {
  let fetchSpy: ReturnType<typeof vi.spyOn>;

  beforeEach(() => {
    fetchSpy = vi.spyOn(globalThis, 'fetch');
  });

  afterEach(() => {
    fetchSpy.mockRestore();
  });

  it('parses slugs from a single markdown URL via rawUrl option', async () => {
    fetchSpy.mockResolvedValueOnce({
      ok: true,
      status: 200,
      text: async () => SAMPLE_MARKDOWN,
    } as Response);

    const slugs = await fetchAwesomeSlugs({ rawUrl: 'https://example.com/test.md' });

    expect(slugs).toContain('acme-git-commit-ai');
    expect(slugs).toContain('octodev-github-pr-review');
    expect(slugs).toContain('statbot-repo-stats');
    expect(slugs).toHaveLength(3);
  });

  it('deduplicates slugs that appear multiple times', async () => {
    const duplicateMarkdown = `
- [foo](https://clawskills.sh/skills/user-foo) - First.
- [foo again](https://clawskills.sh/skills/user-foo) - Duplicate.
- [bar](https://clawskills.sh/skills/user-bar) - Other.
`;
    fetchSpy.mockResolvedValueOnce({
      ok: true,
      status: 200,
      text: async () => duplicateMarkdown,
    } as Response);

    const slugs = await fetchAwesomeSlugs({ rawUrl: 'https://example.com/test.md' });
    expect(slugs).toHaveLength(2);
    expect(new Set(slugs).size).toBe(2);
  });

  it('throws when rawUrl returns non-ok status', async () => {
    fetchSpy.mockResolvedValueOnce({ ok: false, status: 404 } as Response);
    await expect(fetchAwesomeSlugs({ rawUrl: 'https://example.com/missing.md' })).rejects.toThrow('404');
  });

  it('fetches a single category file when category option provided', async () => {
    fetchSpy.mockResolvedValueOnce({
      ok: true,
      status: 200,
      text: async () => SAMPLE_MARKDOWN,
    } as Response);

    const slugs = await fetchAwesomeSlugs({ category: 'git-and-github' });

    // Verify the URL it called
    const calledUrl = (fetchSpy.mock.calls[0][0] as string);
    expect(calledUrl).toContain('categories/git-and-github.md');
    expect(slugs).toContain('acme-git-commit-ai');
  });

  it('normalises category name with spaces and special chars to kebab filename', async () => {
    fetchSpy.mockResolvedValueOnce({
      ok: true,
      status: 200,
      text: async () => SAMPLE_MARKDOWN,
    } as Response);

    await fetchAwesomeSlugs({ category: 'Git & GitHub' });

    const calledUrl = (fetchSpy.mock.calls[0][0] as string);
    expect(calledUrl).toContain('categories/git-github.md');
  });

  it('throws descriptive error when category file not found', async () => {
    fetchSpy.mockResolvedValueOnce({ ok: false, status: 404 } as Response);
    await expect(fetchAwesomeSlugs({ category: 'nonexistent-cat' }))
      .rejects.toThrow('Category "nonexistent-cat" not found');
  });

  it('fetches README then category files when no options given', async () => {
    // First call: README
    fetchSpy.mockResolvedValueOnce({
      ok: true,
      status: 200,
      text: async () => SAMPLE_README,
    } as Response);
    // Second call: git-and-github.md
    fetchSpy.mockResolvedValueOnce({
      ok: true,
      status: 200,
      text: async () => SAMPLE_MARKDOWN,
    } as Response);
    // Third call: coding-agents-and-ides.md
    fetchSpy.mockResolvedValueOnce({
      ok: true,
      status: 200,
      text: async () => '- [code-ai](https://clawskills.sh/skills/dev-code-ai) - Code.',
    } as Response);

    const slugs = await fetchAwesomeSlugs();

    expect(fetchSpy).toHaveBeenCalledTimes(3);
    expect(slugs).toContain('acme-git-commit-ai');
    expect(slugs).toContain('dev-code-ai');
  });

  it('falls back to parsing README directly when no category links found', async () => {
    const readmeWithSlugs = `
No category links here.
- [direct-skill](https://clawskills.sh/skills/user-direct-skill) - Direct.
`;
    fetchSpy.mockResolvedValueOnce({
      ok: true,
      status: 200,
      text: async () => readmeWithSlugs,
    } as Response);

    const slugs = await fetchAwesomeSlugs();
    expect(slugs).toContain('user-direct-skill');
  });
});

describe('downloadSkillsIndex', () => {
  let fetchSpy: ReturnType<typeof vi.spyOn>;

  beforeEach(() => {
    fetchSpy = vi.spyOn(globalThis, 'fetch');
  });

  afterEach(() => {
    fetchSpy.mockRestore();
  });

  it('downloads, decompresses, and returns the skills array', async () => {
    const skills = [
      { slug: 'my-skill', name: 'My Skill', description: 'desc', version: '1.0.0',
        author: 'bob', skillMd: '---\nname: my-skill\n---', metaJson: '{}', invokeScript: null },
    ];
    const gz = makeIndexGz(skills);
    fetchSpy.mockResolvedValueOnce({
      ok: true,
      status: 200,
      arrayBuffer: async () => gz.buffer.slice(gz.byteOffset, gz.byteOffset + gz.byteLength),
    } as unknown as Response);

    const result = await downloadSkillsIndex('https://example.com/skills-index.json.gz');

    expect(result).toHaveLength(1);
    expect(result[0]!.slug).toBe('my-skill');
    expect(result[0]!.skillMd).toBe('---\nname: my-skill\n---');
  });

  it('throws when the download returns a non-ok status', async () => {
    fetchSpy.mockResolvedValueOnce({ ok: false, status: 404 } as Response);
    await expect(downloadSkillsIndex('https://example.com/skills-index.json.gz'))
      .rejects.toThrow('404');
  });

  it('uses SKILLS_INDEX_URL when no url argument is provided', async () => {
    const gz = makeIndexGz([]);
    fetchSpy.mockResolvedValueOnce({
      ok: true,
      status: 200,
      arrayBuffer: async () => gz.buffer.slice(gz.byteOffset, gz.byteOffset + gz.byteLength),
    } as unknown as Response);

    await downloadSkillsIndex();

    const calledUrl = fetchSpy.mock.calls[0]![0] as string;
    expect(calledUrl).toContain('github.com');
    expect(calledUrl).toContain('skills-index.json.gz');
  });
});

describe('installFromIndex', () => {
  let tmpDir: string;

  beforeEach(() => {
    tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'octopus-test-'));
  });

  afterEach(() => {
    fs.rmSync(tmpDir, { recursive: true });
  });

  it('writes SKILL.md and _meta.json for a skill without invokeScript', () => {
    const entry = {
      slug: 'test-skill',
      name: 'Test Skill',
      description: 'A test',
      version: '1.0.0',
      author: 'alice',
      skillMd: '---\nname: test-skill\n---\n\n# Test',
      metaJson: '{"slug":"test-skill","version":"1.0.0"}',
      invokeScript: null,
    };

    installFromIndex(entry, tmpDir);

    const skillDir = path.join(tmpDir, 'test-skill');
    expect(fs.existsSync(path.join(skillDir, 'SKILL.md'))).toBe(true);
    expect(fs.existsSync(path.join(skillDir, '_meta.json'))).toBe(true);
    expect(fs.existsSync(path.join(skillDir, 'scripts', 'invoke.js'))).toBe(false);
    expect(fs.readFileSync(path.join(skillDir, 'SKILL.md'), 'utf8')).toBe('---\nversion: 1.0.0\nname: test-skill\n---\n\n# Test');
    expect(fs.readFileSync(path.join(skillDir, '_meta.json'), 'utf8')).toBe(entry.metaJson);
  });

  it('writes scripts/invoke.js when invokeScript is non-null', () => {
    const entry = {
      slug: 'scripted-skill',
      name: 'Scripted',
      description: '',
      version: '1.0.0',
      author: 'bob',
      skillMd: '---\nname: scripted-skill\n---',
      metaJson: '{}',
      invokeScript: 'console.log("hello")',
    };

    installFromIndex(entry, tmpDir);

    const invokeJsPath = path.join(tmpDir, 'scripted-skill', 'scripts', 'invoke.js');
    expect(fs.existsSync(invokeJsPath)).toBe(true);
    expect(fs.readFileSync(invokeJsPath, 'utf8')).toBe('console.log("hello")');
  });

  it('skips writing if skill already exists and force is false', () => {
    const entry = {
      slug: 'exists',
      name: 'Exists',
      description: '',
      version: '1.0.0',
      author: 'bob',
      skillMd: 'new content',
      metaJson: '{}',
      invokeScript: null,
    };
    const skillDir = path.join(tmpDir, 'exists');
    fs.mkdirSync(skillDir, { recursive: true });
    fs.writeFileSync(path.join(skillDir, 'SKILL.md'), 'old content');

    installFromIndex(entry, tmpDir, false);

    expect(fs.readFileSync(path.join(skillDir, 'SKILL.md'), 'utf8')).toBe('old content');
  });

  it('overwrites existing skill when force is true', () => {
    const entry = {
      slug: 'exists',
      name: 'Exists',
      description: '',
      version: '1.0.0',
      author: 'bob',
      skillMd: 'new content',
      metaJson: '{}',
      invokeScript: null,
    };
    const skillDir = path.join(tmpDir, 'exists');
    fs.mkdirSync(skillDir, { recursive: true });
    fs.writeFileSync(path.join(skillDir, 'SKILL.md'), 'old content');

    installFromIndex(entry, tmpDir, true);

    expect(fs.readFileSync(path.join(skillDir, 'SKILL.md'), 'utf8')).toBe('new content');
  });
});

