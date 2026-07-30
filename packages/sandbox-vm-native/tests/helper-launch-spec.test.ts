import { describe, it, expect } from 'vitest';
import { buildHelperLaunchSpec } from '../src/helper-launch-spec.js';
import type { VmStartConfig } from '@agentoctopus/sandbox';

const config = (over: Partial<VmStartConfig> = {}): VmStartConfig => ({
  rootfsArtifact: { ref: 'sha256:aaa', absolutePath: '/var/rootfs.img', manifestDigest: 'sha256:aaa', size: 1, mode: 0o444 },
  skillBlockImage: { ref: 'sha256:bbb', absolutePath: '/var/skill.img', manifestDigest: 'sha256:bbb', size: 1, mode: 0o444 },
  caBlockImage: { ref: 'sha256:ccc', absolutePath: '/var/ca.img', manifestDigest: 'sha256:ccc', size: 1, mode: 0o444 },
  bootstrapPath: '/usr/libexec/octopus-vm-init',
  bootstrapArgv: ['/usr/libexec/octopus-vm-init', 'PAYLOAD-BLOB'],
  vsockPort: 4242,
  vsockHostSocket: '/run/octopus-vsock-abc.sock',
  memMib: 512,
  cpus: 1,
  readyTimeoutMs: 50,
  libkrunAbi: 'v1.19.4',
  ...over,
});

describe('buildHelperLaunchSpec', () => {
  it('encodes base64url JSON matching the vm-helper.c contract', () => {
    const token = buildHelperLaunchSpec(config());
    // base64url-decode back to JSON
    const json = Buffer.from(token, 'base64url').toString('utf8');
    const spec = JSON.parse(json);
    expect(spec).toEqual({
      rootfsPath: '/var/rootfs.img',
      skillBlockPath: '/var/skill.img',
      caBlockPath: '/var/ca.img',
      vsockPort: 4242,
      vsockHostSocket: '/run/octopus-vsock-abc.sock',
      cpus: 1,
      memMib: 512,
      bootstrapPath: '/usr/libexec/octopus-vm-init',
      bootstrapArgv: ['/usr/libexec/octopus-vm-init', 'PAYLOAD-BLOB'],
      trustedEnv: [],
    });
  });

  it('rejects a non-absolute path (fail-closed)', () => {
    expect(() => buildHelperLaunchSpec(config({ rootfsArtifact: { ref: 'sha256:aaa', absolutePath: 'relative.img', manifestDigest: 'sha256:aaa', size: 1, mode: 0o444 } })))
      .toThrow(/absolute/);
  });

  it('rejects ".." in any path', () => {
    expect(() => buildHelperLaunchSpec(config({ vsockHostSocket: '/run/../etc/passwd' })))
      .toThrow(/\.\./);
  });

  it('rejects bootstrapArgv length != 2', () => {
    expect(() => buildHelperLaunchSpec(config({ bootstrapArgv: ['/x'] }))).toThrow(/2/);
  });

  it('rejects NUL bytes in any string field', () => {
    expect(() => buildHelperLaunchSpec(config({ vsockHostSocket: '/run/octo\0pus.sock' })))
      .toThrow(/NUL/i);
  });
});
