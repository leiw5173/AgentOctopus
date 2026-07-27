import { describe, it, expect } from 'vitest';
import { execSync } from 'node:child_process';
import { dockerAvailable, runDocker } from '../src/docker/cli.js';

// Guard docker-binary-dependent tests so a docker-less dev machine / pre-CI
// environment stays green (review M5). The release lane (Plan 6) has docker.
const hasDockerBin = (() => { try { execSync('docker --version', { stdio: 'pipe' }); return true; } catch { return false; } })();

describe('runDocker', () => {
  it.skipIf(!hasDockerBin)('captures stdout and exit code for a successful command', async () => {
    const res = await runDocker(['--version']);
    expect(res.code).toBe(0);
    expect(res.stdout.toLowerCase()).toContain('docker version');
  });

  it.skipIf(!hasDockerBin)('returns non-zero exit code without throwing for a bad subcommand', async () => {
    const res = await runDocker(['no-such-subcommand-xyz']);
    expect(res.code).not.toBe(0);
  });
});

describe('dockerAvailable', () => {
  it('returns a boolean and never throws', async () => {
    const v = await dockerAvailable();
    expect(typeof v).toBe('boolean');
  });
});
