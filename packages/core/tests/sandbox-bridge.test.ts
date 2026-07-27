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
    // `node` comes from manifest.sandbox.bins — always reachable.
    expect(requestedBins(skill)).toEqual(expect.arrayContaining(['node']));
    expect((toSandboxDescriptor(skill, { snapshotRoot: '/snap/abc', digest: 'sha256:abc', installationId: 'u1' }).request as any).grants).toBeUndefined();
  });
});

// C1 regression: production never populates `manifest.requires`. A SKILL.md
// top-level `requires:` block lands at `entry.metadata.requires` (parsed by
// parseSkillFrontmatter → SkillEntry.metadata). Build the fixture the way
// production actually does and assert requestedBins picks those bins up.
describe('requestedBins — production-shaped fixture (C1)', () => {
  it('reads bins from skill.entry.metadata.requires (the real production location)', () => {
    const prodDir = fs.mkdtempSync(path.join(os.tmpdir(), 'oct-bridge-prod-'));
    fs.writeFileSync(path.join(prodDir, 'SKILL.md'),
      '---\nname: prod\ndescription: p\nrequires:\n  bins:\n    - curl\n    - jq\n---\ncall https://api.example.com\n');
    const prodSkill = {
      dirPath: prodDir,
      manifest: {
        name: 'prod',
        description: 'p',
        adapter: 'subprocess',
        sandbox: { bins: ['node'] },
        credentials: [],
        metadata: {},
      },
      entry: {
        skill: {
          name: 'prod',
          description: 'p',
          version: '1.0.0',
          dirPath: prodDir,
          source: 'user',
          tags: [],
          instructions: 'call https://api.example.com',
          frontmatter: {},
        },
        frontmatter: {},
        metadata: {
          requires: { bins: ['curl', 'jq'] },
        },
        invocation: { userInvocable: true, disableModelInvocation: false },
      },
    } as unknown as LoadedSkill;

    const bins = requestedBins(prodSkill);
    expect(bins).toEqual(expect.arrayContaining(['node', 'curl', 'jq']));
  });

  it('reads bins from manifest.metadata.openclaw.requires.bins via getRequiredBins', () => {
    const ocDir = fs.mkdtempSync(path.join(os.tmpdir(), 'oct-bridge-oc-'));
    fs.writeFileSync(path.join(ocDir, 'SKILL.md'),
      '---\nname: oc\ndescription: o\n---\n');
    const ocSkill = {
      dirPath: ocDir,
      manifest: {
        name: 'oc',
        description: 'o',
        adapter: 'subprocess',
        sandbox: {},
        credentials: [],
        metadata: {
          openclaw: { requires: { bins: ['ffmpeg'] } },
          clawdbot: { requires: { bins: ['rg'] } },
        },
      },
    } as unknown as LoadedSkill;

    const bins = requestedBins(ocSkill);
    expect(bins).toEqual(expect.arrayContaining(['ffmpeg', 'rg']));
  });
});
