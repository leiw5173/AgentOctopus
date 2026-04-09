import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { fetchAwesomeSlugs } from '../src/clawhub.js';

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
