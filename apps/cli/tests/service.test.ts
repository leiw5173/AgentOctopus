import { describe, expect, it } from 'vitest';

import { getRepoRoot, getServiceCommands } from '../src/service.js';

describe('service helpers', () => {
  it('returns the repository root from the CLI source path', () => {
    expect(getRepoRoot('file:///root/AgentOctopus/apps/cli/src/service.ts')).toBe('/root/AgentOctopus');
  });

  it('defines web and gateway startup commands', () => {
    expect(getServiceCommands()).toEqual([
      {
        label: 'web',
        args: ['--filter', 'web', 'dev'],
      },
      {
        label: 'gateway',
        args: ['--filter', '@agentoctopus/gateway', 'start:agent'],
      },
    ]);
  });
});
