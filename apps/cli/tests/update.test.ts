import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import {
  getLatestVersion,
  getInstalledVersion,
  checkPackageUpdates,
  displayUpdateTable,
  runGlobalInstall,
  _setExec,
  _resetExec,
  _setResolveVersion,
  _resetResolveVersion,
} from '../src/update.js';
import type { PackageVersion } from '../src/update.js';

function mockExec(mockFn: (...args: unknown[]) => string) {
  _setExec(mockFn as any);
}

describe('getLatestVersion', () => {
  afterEach(() => {
    _resetExec();
  });

  it('returns the version string from npm view', async () => {
    mockExec(() => '0.4.18\n');
    const result = await getLatestVersion('@agentoctopus/cli');
    expect(result).toBe('0.4.18');
  });

  it('returns null when npm view fails (package not found)', async () => {
    mockExec(() => { throw new Error('not found'); });
    const result = await getLatestVersion('@agentoctopus/nonexistent');
    expect(result).toBeNull();
  });

  it('returns null for empty output', async () => {
    mockExec(() => '');
    const result = await getLatestVersion('@agentoctopus/cli');
    expect(result).toBeNull();
  });
});

describe('getInstalledVersion', () => {
  afterEach(() => {
    _resetExec();
    _resetResolveVersion();
  });

  it('returns version from resolveVersion override', () => {
    _setResolveVersion(() => '0.4.15');
    const result = getInstalledVersion('@agentoctopus/cli');
    expect(result).toBe('0.4.15');
  });

  it('returns null when resolveVersion returns null and npm list fails', () => {
    _setResolveVersion(() => null);
    mockExec(() => { throw new Error('not installed'); });
    const result = getInstalledVersion('@agentoctopus/adapters');
    expect(result).toBeNull();
  });
});

describe('checkPackageUpdates', () => {
  afterEach(() => {
    _resetExec();
    _resetResolveVersion();
  });

  it('returns PackageVersion entries for reachable packages', async () => {
    // Use resolveVersion override for installed versions
    const installedVersions: Record<string, string> = {
      '@agentoctopus/cli': '0.4.15',
      '@agentoctopus/core': '0.4.5',
      '@agentoctopus/registry': '0.4.7',
      '@agentoctopus/adapters': '0.4.1',
      '@agentoctopus/gateway': '0.4.6',
    };
    _setResolveVersion((pkg: string) => installedVersions[pkg] ?? null);

    // Mock npm view for latest versions
    const latestVersions: Record<string, string> = {
      '@agentoctopus/cli': '0.4.18\n',
      '@agentoctopus/core': '0.4.7\n',
      '@agentoctopus/registry': '0.4.8\n',
      '@agentoctopus/adapters': '0.4.2\n',
      '@agentoctopus/gateway': '0.4.7\n',
    };
    mockExec((cmd: string) => {
      for (const [pkg, ver] of Object.entries(latestVersions)) {
        if (cmd.includes(pkg)) return ver;
      }
      throw new Error('not found');
    });

    const results = await checkPackageUpdates();
    expect(results).toHaveLength(5);
    expect(results[0]!.name).toBe('@agentoctopus/cli');
    expect(results[0]!.current).toBe('0.4.15');
    expect(results[0]!.latest).toBe('0.4.18');
  });

  it('skips packages that are unreachable on npm', async () => {
    _setResolveVersion(() => '0.4.0');
    mockExec(() => { throw new Error('network error'); });
    const results = await checkPackageUpdates();
    expect(results).toHaveLength(0);
  });
});

describe('runGlobalInstall', () => {
  afterEach(() => {
    _resetExec();
  });

  it('returns true when npm install succeeds', () => {
    mockExec(() => '');
    expect(runGlobalInstall()).toBe(true);
  });

  it('uses --force flag in the install command', () => {
    let capturedCmd = '';
    mockExec((cmd: string) => { capturedCmd = cmd; return ''; });
    runGlobalInstall();
    expect(capturedCmd).toContain('--force');
  });

  it('throws with npm error message on EEXIST failure', () => {
    const err = Object.assign(new Error('npm failed'), {
      stderr: 'npm error code EEXIST\nnpm error File exists: /usr/bin/octopus\n',
    });
    mockExec(() => { throw err; });
    expect(() => runGlobalInstall()).toThrow('npm error code EEXIST');
  });

  it('throws with fallback message when stderr is empty', () => {
    const err = new Error('spawn failed');
    mockExec(() => { throw err; });
    expect(() => runGlobalInstall()).toThrow('spawn failed');
  });
});

describe('displayUpdateTable', () => {
  let logSpy: ReturnType<typeof vi.spyOn>;

  beforeEach(() => {
    logSpy = vi.spyOn(console, 'log').mockReturnValue(undefined);
  });

  afterEach(() => {
    logSpy.mockRestore();
  });

  it('returns 0 when all packages are up to date', () => {
    const updates: PackageVersion[] = [
      { name: '@agentoctopus/cli', current: '0.4.15', latest: '0.4.15' },
    ];
    const count = displayUpdateTable(updates);
    expect(count).toBe(0);
  });

  it('returns count of packages with available updates', () => {
    const updates: PackageVersion[] = [
      { name: '@agentoctopus/cli', current: '0.4.15', latest: '0.4.18' },
      { name: '@agentoctopus/core', current: '0.4.5', latest: '0.4.7' },
    ];
    const count = displayUpdateTable(updates);
    expect(count).toBe(2);
  });

  it('handles not-installed packages', () => {
    const updates: PackageVersion[] = [
      { name: '@agentoctopus/cli', current: null, latest: '0.4.18' },
    ];
    const count = displayUpdateTable(updates);
    expect(count).toBe(0);
  });
});
