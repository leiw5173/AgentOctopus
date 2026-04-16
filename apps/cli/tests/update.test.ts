import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { getLatestVersion, getInstalledVersion, checkPackageUpdates, displayUpdateTable, _setExec, _resetExec } from '../src/update.js';
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
  });

  it('returns installed version from npm list -g', () => {
    mockExec(() => JSON.stringify({
      dependencies: { '@agentoctopus/cli': { version: '0.4.15' } },
    }));
    const result = getInstalledVersion('@agentoctopus/cli');
    expect(result).toBe('0.4.15');
  });

  it('returns null when package is not installed globally', () => {
    mockExec(() => JSON.stringify({ dependencies: {} }));
    const result = getInstalledVersion('@agentoctopus/cli');
    expect(result).toBeNull();
  });

  it('returns null when npm list fails', () => {
    mockExec(() => { throw new Error('not installed'); });
    const result = getInstalledVersion('@agentoctopus/cli');
    expect(result).toBeNull();
  });
});

describe('checkPackageUpdates', () => {
  afterEach(() => {
    _resetExec();
  });

  it('returns PackageVersion entries for reachable packages', async () => {
    // Call order per package: getInstalledVersion (sync) then getLatestVersion (async)
    const callResults = [
      // @agentoctopus/cli
      JSON.stringify({ dependencies: { '@agentoctopus/cli': { version: '0.4.15' } } }),
      '0.4.18\n',
      // @agentoctopus/core
      JSON.stringify({ dependencies: { '@agentoctopus/core': { version: '0.4.5' } } }),
      '0.4.7\n',
      // @agentoctopus/registry
      JSON.stringify({ dependencies: { '@agentoctopus/registry': { version: '0.4.7' } } }),
      '0.4.8\n',
      // @agentoctopus/adapters
      JSON.stringify({ dependencies: { '@agentoctopus/adapters': { version: '0.4.1' } } }),
      '0.4.2\n',
      // @agentoctopus/gateway
      JSON.stringify({ dependencies: { '@agentoctopus/gateway': { version: '0.4.6' } } }),
      '0.4.7\n',
    ];
    let callIdx = 0;
    mockExec(() => callResults[callIdx++]!);

    const results = await checkPackageUpdates();
    expect(results).toHaveLength(5);
    expect(results[0]!.name).toBe('@agentoctopus/cli');
    expect(results[0]!.current).toBe('0.4.15');
    expect(results[0]!.latest).toBe('0.4.18');
  });

  it('skips packages that are unreachable on npm', async () => {
    mockExec(() => { throw new Error('network error'); });
    const results = await checkPackageUpdates();
    expect(results).toHaveLength(0);
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
