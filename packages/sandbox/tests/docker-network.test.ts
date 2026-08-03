import { describe, it, expect, afterEach } from 'vitest';
import { execSync } from 'node:child_process';
import { createInternalNetwork, removeNetwork, networkExists } from '../src/docker/network.js';

const hasDocker = (() => { try { execSync('docker info', { stdio: 'pipe' }); return true; } catch { return false; } })();
const NAME = `octopus-test-net-${process.pid}`;

afterEach(async () => { await removeNetwork(NAME).catch(() => {}); });

describe.skipIf(!hasDocker)('docker internal network', () => {
  it('creates, detects, and removes an internal network', async () => {
    const id = await createInternalNetwork(NAME);
    expect(id.length).toBeGreaterThan(0);
    expect(await networkExists(NAME)).toBe(true);
    await removeNetwork(NAME);
    expect(await networkExists(NAME)).toBe(false);
  });

  it('removeNetwork is idempotent', async () => {
    await expect(removeNetwork('octopus-nonexistent-net')).resolves.toBeUndefined();
  });
});
