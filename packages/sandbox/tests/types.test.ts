import { describe, it, expect } from 'vitest';
import type {
  InstallationIdentity,
  SandboxSkillDescriptor,
  SandboxResultMeta,
} from '../src/types.js';

describe('sandbox domain types', () => {
  it('constructs an InstallationIdentity with a snapshotRef', () => {
    const id: InstallationIdentity = {
      installationId: 'uuid-1',
      digest: 'sha256:abc',
      snapshotRef: 'sha256:abc',
      name: 'weather',
      source: { publisher: 'community' },
    };
    expect(id.snapshotRef).toBe('sha256:abc');
  });

  it('constructs a SandboxSkillDescriptor', () => {
    const d: SandboxSkillDescriptor = {
      identity: {
        installationId: 'uuid-1',
        digest: 'sha256:abc',
        snapshotRef: 'sha256:abc',
        name: 'weather',
      },
      snapshotRoot: '/snapshots/sha256:abc',
      request: { hosts: ['wttr.in'], credentials: ['WTR_API_KEY'] },
    };
    expect(d.request.hosts).toContain('wttr.in');
  });

  it('constructs a SandboxResultMeta with an isolation level', () => {
    const m: SandboxResultMeta = {
      isolationLevel: 'full',
      backend: 'docker',
      degraded: false,
      degradationReasons: [],
    };
    expect(m.isolationLevel).toBe('full');
  });
});
