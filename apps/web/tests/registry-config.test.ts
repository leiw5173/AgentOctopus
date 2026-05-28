import { describe, expect, it, vi } from 'vitest';

const { mockLoadConfig, mockGetConfigDir, mockSkillRegistry } = vi.hoisted(() => ({
  mockLoadConfig: vi.fn(),
  mockGetConfigDir: vi.fn(),
  mockSkillRegistry: vi.fn(),
}));

vi.mock('@agentoctopus/core', () => ({
  loadConfig: mockLoadConfig,
  getConfigDir: mockGetConfigDir,
}));

vi.mock('@agentoctopus/registry', () => ({
  SkillRegistry: mockSkillRegistry.mockImplementation(function MockSkillRegistry(this: { noCache?: boolean }) {
    this.noCache = false;
  }),
}));

describe('registry config', () => {
  it('creates the skill registry from configured paths', async () => {
    mockLoadConfig.mockReturnValue({
      registry: {
        skillsDir: 'skills',
        ratingsPath: 'ratings.json',
        noCache: true,
      },
    });
    mockGetConfigDir.mockReturnValue('/project/apps/web/.agentoctopus');

    const { createConfiguredRegistry } = await import('../src/app/api/registry-config.js');
    const registry = createConfiguredRegistry();

    expect(mockSkillRegistry).toHaveBeenCalledWith(
      '/project/apps/web/.agentoctopus/skills',
      '/project/apps/web/.agentoctopus/ratings.json',
    );
    expect(registry.noCache).toBe(true);
  });

  it('handles absolute paths without joining to config dir', async () => {
    mockLoadConfig.mockReturnValue({
      registry: {
        skillsDir: '/absolute/skills',
        ratingsPath: '/absolute/ratings.json',
        noCache: false,
      },
    });
    mockGetConfigDir.mockReturnValue('/project/apps/web/.agentoctopus');

    const { createConfiguredRegistry } = await import('../src/app/api/registry-config.js');
    createConfiguredRegistry();

    expect(mockSkillRegistry).toHaveBeenCalledWith(
      '/absolute/skills',
      '/absolute/ratings.json',
    );
  });
});
