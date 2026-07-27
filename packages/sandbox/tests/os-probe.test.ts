import { describe, it, expect } from 'vitest';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { fullLevel, probeOsCaps, type OsCaps } from '../src/os/probe.js';

const execFileAsync = promisify(execFile);

const full: OsCaps = {
  platform: 'linux',
  userMountPidIpcUtsNs: true,
  namedNetns: true,
  nftRuleCreate: true,
  cgroupV2Writable: true,
  runtimeArtifact: true,
  helperArtifact: true,
  sandboxExec: false,
  probeErrors: [],
};

describe('fullLevel', () => {
  it('grants full only when every real Linux probe succeeded', () => {
    expect(fullLevel(full)).toBe('full');
  });

  for (const key of [
    'userMountPidIpcUtsNs', 'namedNetns', 'nftRuleCreate',
    'cgroupV2Writable', 'runtimeArtifact', 'helperArtifact',
  ] as const) {
    it(`is restricted when ${key} fails`, () => {
      expect(fullLevel({ ...full, [key]: false, probeErrors: [`${key} failed`] })).toBe('restricted');
    });
  }

  it('is restricted when cleanup/probe reported any error', () => {
    expect(fullLevel({ ...full, probeErrors: ['nft cleanup failed'] })).toBe('restricted');
  });

  it('is restricted on macOS even if sandbox-exec exists', () => {
    expect(fullLevel({ ...full, platform: 'darwin', sandboxExec: true })).toBe('restricted');
  });
});

// ---------------------------------------------------------------------------
// Linux-only smoke test — real kernel-object create/cleanup proof.
//
// Pattern: capability-skip like `docker-cli.test.ts` (`it.skipIf(!hasDockerBin)`).
// On macOS the whole describe skips. On the Plan 6 privileged Linux lane,
// OCTOPUS_REQUIRE_OS_SANDBOX=1 converts a "skipped because capability missing"
// outcome into a hard failure so a regression cannot silently degrade the lane.
// ---------------------------------------------------------------------------

const isLinux = process.platform === 'linux';
const REQUIRE_OS = process.env.OCTOPUS_REQUIRE_OS_SANDBOX === '1';

const PROBE_MANIFEST_ROOT = process.env.OCTOPUS_OS_PROBE_MANIFEST_ROOT
  ?? '/opt/agentoctopus/os-sandbox';

async function snapshotNetns(): Promise<string[]> {
  const { stdout } = await execFileAsync('ip', ['netns', 'list']);
  return stdout.split('\n').map((l) => l.trim()).filter(Boolean);
}

async function snapshotNftTables(): Promise<string[]> {
  const { stdout } = await execFileAsync('nft', ['list', 'tables']);
  return stdout.split('\n').map((l) => l.trim()).filter(Boolean);
}

async function snapshotCgroups(): Promise<string[]> {
  const { stdout } = await execFileAsync('find', [
    '/sys/fs/cgroup', '-maxdepth', '1', '-mindepth', '1', '-type', 'd', '-printf', '%f\n',
  ]);
  return stdout.split('\n').map((l) => l.trim()).filter(Boolean);
}

describe.skipIf(!isLinux)('probeOsCaps linux smoke', () => {
  it('creates and cleans its own netns/nft/cgroup objects', async () => {
    // On the privileged Plan 6 lane, missing manifests is a hard failure.
    // Outside it we skip — capability not present on this machine.
    let manifestsPresent = true;
    try {
      await execFileAsync('test', ['-f', `${PROBE_MANIFEST_ROOT}/runtime.manifest.json`]);
      await execFileAsync('test', ['-f', `${PROBE_MANIFEST_ROOT}/helper.manifest.json`]);
    } catch {
      manifestsPresent = false;
    }
    if (!manifestsPresent) {
      if (REQUIRE_OS) {
        throw new Error(
          `OCTOPUS_REQUIRE_OS_SANDBOX=1 but manifests not found under ${PROBE_MANIFEST_ROOT}`,
        );
      }
      return; // soft skip: manifests not installed on this host
    }

    const beforeNetns = await snapshotNetns();
    const beforeTables = await snapshotNftTables();
    const beforeCgroups = await snapshotCgroups();

    const caps = await probeOsCaps({
      runtimeManifestPath: `${PROBE_MANIFEST_ROOT}/runtime.manifest.json`,
      helperManifestPath: `${PROBE_MANIFEST_ROOT}/helper.manifest.json`,
      helperBinaryPath: `${PROBE_MANIFEST_ROOT}/helper`,
    });

    const afterNetns = await snapshotNetns();
    const afterTables = await snapshotNftTables();
    const afterCgroups = await snapshotCgroups();

    if (REQUIRE_OS && caps.probeErrors.length > 0) {
      throw new Error(`probe reported errors on required lane: ${caps.probeErrors.join('; ')}`);
    }

    // Every object the probe may have created must be gone. The probe's token
    // (surfaced via probeErrors when cleanup fails) is the only marker we can
    // assert on; the leak-detection here is "no diff vs. before".
    expect(afterNetns.filter((n) => !beforeNetns.includes(n))).toEqual([]);
    expect(afterTables.filter((t) => !beforeTables.includes(t))).toEqual([]);
    expect(afterCgroups.filter((c) => !beforeCgroups.includes(c))).toEqual([]);

    if (REQUIRE_OS) {
      expect(fullLevel(caps)).toBe('full');
    }
  });
});
