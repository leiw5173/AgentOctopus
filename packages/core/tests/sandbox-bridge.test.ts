import { describe, it, expect, beforeAll } from 'vitest';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { toSandboxDescriptor, requestedHosts, requestedCredentials, requestedBins } from '../src/sandbox-bridge.js';
import type { LoadedSkill } from '@agentoctopus/registry';

// Use a real on-disk skill dir so getSkillEntry() reads instructions from
// SKILL.md exactly as production does (review m12 — a bare `skill.skill`
// cast is ignored by getSkillEntry, which would silently yield no hosts).
let dir: string;
let skill: LoadedSkill;

beforeAll(() => {
  dir = fs.mkdtempSync(path.join(os.tmpdir(), 'oct-bridge-'));
  fs.writeFileSync(path.join(dir, 'SKILL.md'),
    '---\nname: weather\ndescription: wttr\n---\ncall https://wttr.in and https://api.example.com/v1\n');
  skill = {
    dirPath: dir,
    manifest: {
      name: 'weather',
      description: 'wttr',
      adapter: 'subprocess',
      sandbox: { hosts: ['declared.example'], credentials: ['DECLARED_KEY'], bins: ['node'] },
      credentials: [{ key: 'WTR_API_KEY', label: 'wttr key', required: true }],
      requires: { bins: ['curl'] },
      metadata: {},
    },
  } as unknown as LoadedSkill;
});

describe('toSandboxDescriptor', () => {
  it('maps identity with installationId+digest as grant keys and name as untrusted', () => {
    const d = toSandboxDescriptor(skill, { snapshotRoot: '/snap/abc', digest: 'sha256:abc', installationId: 'u1' });
    expect(d.identity.installationId).toBe('u1');
    expect(d.identity.digest).toBe('sha256:abc');
    expect(d.identity.name).toBe('weather');
    expect(d.snapshotRoot).toBe('/snap/abc');
  });

  it('extracts requested hosts from the on-disk instructions (covers the host path)', () => {
    const d = toSandboxDescriptor(skill, { snapshotRoot: '/snap/abc', digest: 'sha256:abc', installationId: 'u1' });
    expect(d.request.hosts).toContain('wttr.in');
    expect(d.request.hosts).toContain('api.example.com');
    expect(d.request.credentials).toContain('WTR_API_KEY');
  });

  it('collects only request-side credentials, hosts, and bins', () => {
    expect(requestedCredentials(skill)).toEqual(expect.arrayContaining(['WTR_API_KEY', 'DECLARED_KEY']));
    const hosts = requestedHosts(skill, 'call https://wttr.in and https://api.example.com/v1');
    expect(hosts).toEqual(expect.arrayContaining(['declared.example', 'wttr.in', 'api.example.com']));
    expect(requestedBins(skill)).toEqual(expect.arrayContaining(['node', 'curl']));
    expect((toSandboxDescriptor(skill, { snapshotRoot: '/snap/abc', digest: 'sha256:abc', installationId: 'u1' }).request as any).grants).toBeUndefined();
  });
});
