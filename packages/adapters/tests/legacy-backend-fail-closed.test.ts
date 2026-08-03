/**
 * Legacy Docker/SSH/OpenShell adapter removal + fail-closed backend selection
 * (Plan 5 Task 4, matrix rows: "legacy Docker override", "legacy SSH override",
 * "legacy OpenShell override", "defaultBackend: none/subprocess under
 * minIsolationLevel: full").
 *
 * The legacy host adapters (DockerAdapter spawning host `docker run`, SshAdapter
 * spawning host `ssh`, OpenShellAdapter delegating to host SubprocessAdapter)
 * are REMOVED — the canonical backends in @agentoctopus/sandbox replace them.
 * These tests assert the removal and the fail-closed selection contract.
 */
import { describe, it, expect } from 'vitest';
import fs from 'node:fs';
import path from 'node:path';
import {
  selectBackend,
  NoFullBackendError,
  SandboxConfigSchema,
  type SandboxBackend,
} from '@agentoctopus/sandbox';
import * as adapters from '../src/index.js';

const SRC_DIR = path.join(__dirname, '..', 'src');

describe('legacy host adapters are removed', () => {
  it('barrel no longer exports DockerAdapter / SshAdapter / OpenShellAdapter', () => {
    expect((adapters as Record<string, unknown>)['DockerAdapter']).toBeUndefined();
    expect((adapters as Record<string, unknown>)['SshAdapter']).toBeUndefined();
    expect((adapters as Record<string, unknown>)['OpenShellAdapter']).toBeUndefined();
  });

  it('legacy adapter source files are absent', () => {
    for (const f of [
      'sandbox/docker-adapter.ts',
      'sandbox/ssh-adapter.ts',
      'sandbox/openshell-adapter.ts',
      'sandbox/index.ts',
    ]) {
      expect(fs.existsSync(path.join(SRC_DIR, f)), `${f} should be deleted`).toBe(false);
    }
  });

  it('source guard: no converged source matches env: process.env | pkill | OpenShell spawn', () => {
    // MCP is Task 5's boundary (host transport left in place); the host-spawn
    // env/pkill patterns must not appear in the CONVERGED execution sources.
    const converged = ['adapter.ts', 'subprocess-adapter.ts', 'http-adapter.ts', 'index.ts']
      .map((f) => fs.readFileSync(path.join(SRC_DIR, f), 'utf-8'))
      .join('\n');
    expect(converged).not.toMatch(/env:\s*process\.env|pkill|OpenShell.*spawn/si);
  });
});

describe('fail-closed backend selection (no weaker fallback)', () => {
  const baseConfig = SandboxConfigSchema.parse({
    defaultBackend: 'auto',
    minIsolationLevel: 'full',
  });

  it('defaultBackend: none under minIsolationLevel: full → NO_SATISFYING_BACKEND, zero execution', async () => {
    const config = SandboxConfigSchema.parse({ ...baseConfig, defaultBackend: 'none' });
    await expect(selectBackend(config, [])).rejects.toBeInstanceOf(NoFullBackendError);
  });

  it('defaultBackend: subprocess under minIsolationLevel: full → fail closed', async () => {
    const config = SandboxConfigSchema.parse({ ...baseConfig, defaultBackend: 'subprocess' });
    // A weak (isolationLevel: none) subprocess-ish backend must never satisfy
    // a full-isolation requirement.
    const weakBackend = {
      kind: 'subprocess',
      isolationLevel: 'none',
      probe: async () => true,
      prepareTopology: async () => { throw new Error('should not be called'); },
      prepare: async () => {},
      spawn: async () => { throw new Error('should not be called'); },
      run: async () => { throw new Error('should not be called'); },
      cleanup: async () => {},
    } as unknown as SandboxBackend;

    await expect(selectBackend(config, [weakBackend])).rejects.toBeInstanceOf(NoFullBackendError);
    await expect(selectBackend(config, [weakBackend])).rejects.toThrow(/fail-closed/);
  });

  it('a too-weak backend is excluded even when it probes successfully', async () => {
    const weak = {
      kind: 'subprocess',
      isolationLevel: 'restricted', // below required 'full'
      probe: async () => true,
    } as unknown as SandboxBackend;
    await expect(selectBackend(baseConfig, [weak])).rejects.toBeInstanceOf(NoFullBackendError);
  });
});
