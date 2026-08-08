import { describe, it, expect } from 'vitest';
import { SandboxConfigSchema } from '../src/schema.js';
import { DockerBackend } from '../src/docker/docker-backend.js';
import { resolvePolicy } from '../src/policy.js';
import type { BackendPrepareOptions } from '../src/backend.js';
import type { SandboxSkillDescriptor } from '../src/types.js';

describe('windowsRuntime profile schema', () => {
  it('accepts a runtime profile carrying windowsRuntime', () => {
    const cfg = SandboxConfigSchema.parse({
      defaultBackend: 'windows',
      minIsolationLevel: 'restricted',
      runtimeProfiles: {
        'win-rt': {
          bins: ['node'],
          path: 'C:\\octopus\\rt',
          windowsRuntime: {
            manifestPath: 'C:\\octopus\\rt\\runtime.manifest.json',
            nodePath: 'C:\\octopus\\rt\\node.exe',
            bootstrapPath: 'C:\\octopus\\rt\\bootstrap.cjs',
          },
        },
      },
    });
    expect(cfg.runtimeProfiles?.['win-rt']?.windowsRuntime?.nodePath).toBe('C:\\octopus\\rt\\node.exe');
  });
});

// ---------------------------------------------------------------------------
// Per-backend canonical guest path assertions (Task 3). After Task 2 widened
// `BackendPrepareOptions.guestSkillRoot` / `guestCaBundlePath` from the
// literal type to `string`, each Linux-class backend (docker/os/vm) must
// assert the canonical literals at runtime — the literal-type guard is gone.
// These tests pin that behavior at the docker backend (the windows backend
// will assert its own staged-copy path in a later task).
// ---------------------------------------------------------------------------

const DUMMY_IMAGE = `alpine@sha256:${'a'.repeat(64)}`; // syntax-only fixture; never executed

describe('per-backend guest path assertions', () => {
  const unitConfig = SandboxConfigSchema.parse({
    docker: { image: DUMMY_IMAGE, memory: '128m', cpus: '0.5', pids: 32, ulimits: { nofile: 128, fsize: '16m' } },
    proxy: { artifact: DUMMY_IMAGE },
    defaults: { memory: '512m', timeoutMs: 15000, cpus: '2', outputMaxBytes: 65536 },
  });

  function makeDescriptor(): SandboxSkillDescriptor {
    return {
      identity: {
        installationId: 'u1:t',
        digest: `sha256:${'a'.repeat(64)}`,
      },
      snapshotRoot: '/x',
      request: {},
    } as SandboxSkillDescriptor;
  }

  function prepareOpts(overrides: Partial<BackendPrepareOptions> = {}): BackendPrepareOptions {
    const descriptor = makeDescriptor();
    return {
      ...resolvePolicy(descriptor, unitConfig),
      snapshotRoot: descriptor.snapshotRoot,
      expectedSnapshotDigest: descriptor.identity.digest,
      proxyAddr: 'http://egress-proxy:8080',
      caBundlePath: '/y',
      runtimeProfile: { id: 'unit', bins: ['node'], path: '/usr/local/bin', dockerImage: DUMMY_IMAGE },
      guestSkillRoot: '/skill',
      guestCaBundlePath: '/etc/skill-ca/ca.pem',
      ...overrides,
    };
  }

  function makeBackend(): DockerBackend {
    const b = new DockerBackend({ config: unitConfig, sessionId: 'test1234' });
    // Inject a docker-sidecar carrier directly so prepare() does not require
    // prepareTopology() (which would need a live Docker daemon).
    (b as unknown as { carrier: unknown }).carrier = {
      kind: 'docker-sidecar',
      proxyImage: DUMMY_IMAGE,
      internalNetwork: 'i',
      egressNetwork: 'e',
      reachableHost: 'egress-proxy',
    };
    return b;
  }

  it('docker backend rejects a Windows-style guestSkillRoot', async () => {
    const b = makeBackend();
    await expect(b.prepare(prepareOpts({ guestSkillRoot: 'C:\\staged\\skill' })))
      .rejects.toThrow(/invalid canonical guest mount paths/i);
  });

  it('docker backend rejects a Windows-style guestCaBundlePath', async () => {
    const b = makeBackend();
    await expect(b.prepare(prepareOpts({ guestCaBundlePath: 'C:\\staged\\ca.pem' })))
      .rejects.toThrow(/invalid canonical guest mount paths/i);
  });

  it('docker backend accepts the canonical Linux literals', async () => {
    const b = makeBackend();
    await expect(b.prepare(prepareOpts())).resolves.toBeUndefined();
  });
});
