import { describe, expect, it, vi } from 'vitest';

const { mockLoadConfig, mockSkillRegistry } = vi.hoisted(() => ({
  mockLoadConfig: vi.fn(),
  mockSkillRegistry: vi.fn(),
}));

vi.mock('@agentoctopus/core', () => ({
  loadConfig: mockLoadConfig,
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
        skillsDir: '../../.agentoctopus/skills',
        ratingsPath: '../../.agentoctopus/ratings.json',
        noCache: true,
      },
    });

    const { createConfiguredRegistry } = await import('../src/app/api/registry-config.js');
    const registry = createConfiguredRegistry();

    expect(mockSkillRegistry).toHaveBeenCalledWith(
      expect.stringContaining('.agentoctopus/skills'),
      expect.stringContaining('.agentoctopus/ratings.json'),
    );
    expect(registry.noCache).toBe(true);
  });
});
