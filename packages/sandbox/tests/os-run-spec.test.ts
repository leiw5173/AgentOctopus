/**
 * Tests for packages/sandbox/src/os/run-spec.ts (Plan 4, Task 3).
 *
 * `buildOsRunCommand` is a pure serializer + verifier: it digests the helper
 * artifact pair immediately before producing the launch argv, writes the
 * root-owned 0600 launch spec, and returns the direct helper argv. It never
 * emits shell text and never depends on an in-root shell.
 *
 * These tests are portable — they run on macOS. The launch-spec file is
 * written into a tmp dir; the helper artifact pair is a fixture produced at
 * test time so `verifyHelperArtifact` has real bytes to check.
 */
import { describe, it, expect, afterEach } from 'vitest';
import crypto from 'node:crypto';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { buildOsRunCommand } from '../src/os/run-spec.js';
import type { RootfsLayout } from '../src/os/rootfs.js';
import type { NetnsHandle } from '../src/os/netns.js';

const layout = {
  root: '/run/oct/root', runtimeRoot: '/run/oct/root',
  hostMounts: { snapshotSource: '/snap/a', snapshotTarget: '/run/oct/root/skill', caSource: '/ca.pem', caTarget: '/run/oct/root/etc/skill-ca/ca.pem' },
  inRoot: { node: '/usr/bin/node', skill: '/skill', ca: '/etc/skill-ca/ca.pem', tmp: '/tmp', proc: '/proc', dev: '/dev' },
  cleanup: async () => {},
} satisfies RootfsLayout;
const netns = { name: 'octn-deadbeef', path: '/run/netns/octn-deadbeef', proxyIp: '169.254.7.1', skillIp: '169.254.7.2', proxyPort: 43123, nftTable: 'oct_deadbeef', hostIf: 'ohdeadbeef', skillIf: 'osdeadbeef', cleanup: async () => {} } satisfies NetnsHandle;

// ---------------------------------------------------------------------------
// Fixture: a real helper + manifest pair so verifyHelperArtifact has bytes.
// ---------------------------------------------------------------------------

interface Tmp { dir: string; cleanup: () => Promise<void> }
const tmps: Tmp[] = [];
afterEach(async () => {
  while (tmps.length) await tmps.pop()!.cleanup();
});

async function makeHelperPair(): Promise<{ helperPath: string; helperManifestPath: string }> {
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), 'oct-run-spec-'));
  tmps.push({ dir, cleanup: () => fs.rm(dir, { recursive: true, force: true }) });
  const helperPath = path.join(dir, 'os-helper');
  const helperManifestPath = path.join(dir, 'os-helper.manifest.json');
  const bytes = Buffer.from('fake static helper bytes for digest verification');
  await fs.writeFile(helperPath, bytes, { mode: 0o755 });
  const helperSha256 = crypto.createHash('sha256').update(bytes).digest('hex');
  await fs.writeFile(helperManifestPath, JSON.stringify({
    schemaVersion: 1,
    helperSha256,
    size: bytes.length,
    mode: 0o755,
  }, null, 2) + '\n');
  return { helperPath, helperManifestPath };
}

describe('buildOsRunCommand', () => {
  it('serializes host-path mount phase separately from in-root exec phase', async () => {
    const { helperPath, helperManifestPath } = await makeHelperPair();
    const cmd = await buildOsRunCommand({
      helperPath, helperManifestPath, layout, netns,
      spec: { command: ['/usr/bin/node', '/skill/invoke.js'], cwd: '/skill' },
      proxyAddr: 'http://169.254.7.1:43123',
    });
    expect(cmd.file).toBe(helperPath);
    expect(cmd.args).toEqual(['--launch-spec', cmd.launchSpecPath, '--stop-before-exec']);
    const launch = JSON.parse(await fs.readFile(cmd.launchSpecPath, 'utf8'));
    expect(launch.netnsPath).toBe('/run/netns/octn-deadbeef');
    expect(launch.hostBinds).toEqual(expect.arrayContaining([
      expect.objectContaining({ source: '/snap/a', target: '/run/oct/root/skill' }),
      expect.objectContaining({ source: '/ca.pem', target: '/run/oct/root/etc/skill-ca/ca.pem' }),
    ]));
    expect(launch.cwd).toBe('/skill');
    expect(launch.command).toEqual(['/usr/bin/node', '/skill/invoke.js']);
    expect(JSON.stringify(launch.command)).not.toContain('/run/oct/root/skill');
    expect(launch.env.HTTPS_PROXY).toBe('http://169.254.7.1:43123');

    // Launch spec is 0600.
    const st = await fs.stat(cmd.launchSpecPath);
    expect(st.mode & 0o777).toBe(0o600);
  });

  it('never depends on an in-root shell or anonymous net namespace', async () => {
    const { helperPath, helperManifestPath } = await makeHelperPair();
    const cmd = await buildOsRunCommand({
      helperPath, helperManifestPath, layout, netns,
      spec: { command: ['/usr/bin/node', '--version'] },
      proxyAddr: 'http://169.254.7.1:43123',
    });
    const text = [cmd.file, ...cmd.args].join(' ');
    expect(text).not.toMatch(/\/bin\/sh|sh -c|unshare --net/);
  });

  it('fails closed when the helper digest does not match the manifest', async () => {
    const { helperPath, helperManifestPath } = await makeHelperPair();
    // Tamper with the helper bytes after the manifest was written.
    await fs.appendFile(helperPath, Buffer.from([0]));
    await expect(buildOsRunCommand({
      helperPath, helperManifestPath, layout, netns,
      spec: { command: ['/usr/bin/node', '--version'] },
      proxyAddr: 'http://169.254.7.1:43123',
    })).rejects.toThrow(/digest/i);
  });

  it('fails closed when the helper manifest is missing', async () => {
    const dir = await fs.mkdtemp(path.join(os.tmpdir(), 'oct-run-spec-'));
    tmps.push({ dir, cleanup: () => fs.rm(dir, { recursive: true, force: true }) });
    await expect(buildOsRunCommand({
      helperPath: path.join(dir, 'os-helper'),
      helperManifestPath: path.join(dir, 'os-helper.manifest.json'),
      layout, netns,
      spec: { command: ['/usr/bin/node', '--version'] },
      proxyAddr: 'http://169.254.7.1:43123',
    })).rejects.toThrow();
  });
});
