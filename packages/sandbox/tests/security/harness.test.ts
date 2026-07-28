import { describe, it, expect } from 'vitest';
import { mkdtempSync, existsSync, readFileSync, rmSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import {
  requirePinnedImageRef,
  createHostCanary,
  probeDocker,
  probePrivilegedLinux,
  probeMacSandbox,
  makeProbeSkill,
  PROBE_SCRIPT,
} from './harness.js';

describe('security harness', () => {
  it('accepts immutable image references and rejects mutable/sentinel values', () => {
    const d = 'a'.repeat(64);
    expect(requirePinnedImageRef('runtime', `registry.example/runtime@sha256:${d}`)).toContain('@sha256:');
    expect(requirePinnedImageRef('runtime', `sha256:${d}`)).toBe(`sha256:${d}`);
    for (const bad of ['node:22-alpine', 'runtime:latest', 'runtime', 'sha256:MISSING', 'REPLACE_WITH_DIGEST']) {
      expect(() => requirePinnedImageRef('runtime', bad)).toThrow(/immutable.*sha256/i);
    }
  });

  it('matches the schema regex exactly: registry port accepted, uppercase rejected', () => {
    const d = 'a'.repeat(64);
    // Schema accepts a registry with an explicit port (a port, not a tag).
    expect(requirePinnedImageRef('runtime', `registry.example:5000/runtime@sha256:${d}`)).toContain('@sha256:');
    // Schema is lowercase-only (no `i` flag) — the gate must not be looser than the schema.
    expect(() => requirePinnedImageRef('runtime', `RUNTIME@sha256:${d}`)).toThrow(/immutable.*sha256/i);
  });

  it('creates a unique host canary at a path not intrinsic to the container', () => {
    const c = createHostCanary();
    try {
      expect(c.containerPath).toMatch(/^\/host-canary\/[0-9a-f-]+\/canary$/);
      expect(c.content).toMatch(/^octopus-host-only-/);
    } finally { c.cleanup(); }
  });

  it('uses direct Node probes, not host files or shell tools', () => {
    expect(PROBE_SCRIPT).toContain("action === 'host-canary-read'");
    expect(PROBE_SCRIPT).toContain("action === 'host-canary-write'");
    expect(PROBE_SCRIPT).toContain("action === 'direct-internet'");
    expect(PROBE_SCRIPT).not.toContain('/etc/passwd');
    expect(PROBE_SCRIPT).not.toMatch(/curl|wget|bash -c|sh -c/);
  });

  it('makeProbeSkill writes scripts/probe.js whose contents equal PROBE_SCRIPT', async () => {
    const dir = mkdtempSync(join(tmpdir(), 'octopus-probeskill-'));
    try {
      const probePath = await makeProbeSkill(dir);
      expect(probePath).toBe(join(dir, 'scripts', 'probe.js'));
      expect(existsSync(probePath)).toBe(true);
      expect(readFileSync(probePath, 'utf8')).toBe(PROBE_SCRIPT);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it('capability probes return reasoned results without throwing', async () => {
    for (const result of await Promise.all([probeDocker(), probePrivilegedLinux(), probeMacSandbox()])) {
      expect(typeof result.available).toBe('boolean');
      if (!result.available) expect(result.reason).toBeTruthy();
    }
  });
});
