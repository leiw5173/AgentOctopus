import { execSync as nodeExecSync } from 'child_process';
import chalk from 'chalk';
import fs from 'fs';
import path from 'path';
import { fileURLToPath } from 'url';
import { createRequire } from 'module';

/** Packages to check for updates (CLI pulls in the rest transitively) */
const PACKAGES = [
  '@agentoctopus/cli',
  '@agentoctopus/core',
  '@agentoctopus/registry',
  '@agentoctopus/adapters',
  '@agentoctopus/gateway',
] as const;

export interface PackageVersion {
  name: string;
  current: string | null;
  latest: string;
}

/**
 * Injectable execSync for testing. Override `_exec` before calling functions.
 */
let _exec: typeof nodeExecSync = nodeExecSync;

/** Set the exec implementation (for testing). */
export function _setExec(fn: typeof nodeExecSync): void {
  _exec = fn;
}

/** Reset exec to the real implementation. */
export function _resetExec(): void {
  _exec = nodeExecSync;
}

/**
 * Injectable version resolver for testing.
 */
let _resolveVersion: ((pkg: string) => string | null) | null = null;

/** Set a custom version resolver (for testing). */
export function _setResolveVersion(fn: (pkg: string) => string | null): void {
  _resolveVersion = fn;
}

/** Reset version resolver to default. */
export function _resetResolveVersion(): void {
  _resolveVersion = null;
}

/**
 * Query npm registry for the latest version of a package.
 * Returns null if the package is not found or the registry is unreachable.
 */
export async function getLatestVersion(pkg: string): Promise<string | null> {
  try {
    const result = _exec(`npm view ${pkg} version`, { encoding: 'utf8', timeout: 15000 }).trim();
    return result || null;
  } catch {
    return null;
  }
}

/**
 * Get the currently installed version of a package.
 * Uses Node's module resolution (works with pnpm symlinks) to find the package.json.
 * Falls back to npm list -g for global installs outside any workspace.
 */
export function getInstalledVersion(pkg: string): string | null {
  // Allow test override
  if (_resolveVersion) return _resolveVersion(pkg);

  // For the CLI itself, read from its own package.json
  if (pkg === '@agentoctopus/cli') {
    try {
      const __cliDir = path.dirname(fileURLToPath(import.meta.url));
      const data = JSON.parse(fs.readFileSync(path.join(__cliDir, '..', 'package.json'), 'utf8'));
      if (data.version) return data.version;
    } catch {
      // Fall through
    }
  }

  // Use require.resolve to find the package through Node's resolution
  // This follows pnpm symlinks correctly
  try {
    const require = createRequire(import.meta.url);
    const mainPath = require.resolve(pkg);
    // Walk up from the resolved file to find package.json
    let dir = path.dirname(mainPath);
    for (let i = 0; i < 5; i++) {
      const pkgJsonPath = path.join(dir, 'package.json');
      if (fs.existsSync(pkgJsonPath)) {
        const data = JSON.parse(fs.readFileSync(pkgJsonPath, 'utf8'));
        if (data.name === pkg && data.version) return data.version;
      }
      dir = path.dirname(dir);
    }
  } catch {
    // Fall through
  }

  // For packages not directly required by CLI, try resolving through a known dependency
  // (e.g. @agentoctopus/adapters is a dep of @agentoctopus/core)
  try {
    const require = createRequire(import.meta.url);
    const corePath = require.resolve('@agentoctopus/core');
    const coreDir = path.dirname(corePath);
    // Walk up to find core's package root, then look in its node_modules
    let dir = coreDir;
    for (let i = 0; i < 5; i++) {
      const candidate = path.join(dir, 'node_modules', pkg, 'package.json');
      if (fs.existsSync(candidate)) {
        const data = JSON.parse(fs.readFileSync(candidate, 'utf8'));
        if (data.name === pkg && data.version) return data.version;
      }
      dir = path.dirname(dir);
    }
  } catch {
    // Fall through to global check
  }

  // Fallback: check global install via npm list -g
  try {
    const result = _exec(`npm list -g ${pkg} --json`, { encoding: 'utf8', timeout: 10000 }).trim();
    const data = JSON.parse(result);
    const deps = data.dependencies ?? {};
    const entry = deps[pkg];
    if (entry && entry.version) {
      return entry.version;
    }
    return null;
  } catch {
    return null;
  }
}

/**
 * Check all @agentoctopus packages for available updates.
 * Returns a list of PackageVersion objects with current and latest versions.
 */
export async function checkPackageUpdates(): Promise<PackageVersion[]> {
  const results: PackageVersion[] = [];

  for (const pkg of PACKAGES) {
    const [current, latest] = await Promise.all([
      Promise.resolve(getInstalledVersion(pkg)),
      getLatestVersion(pkg),
    ]);

    if (latest !== null) {
      results.push({ name: pkg, current, latest });
    }
  }

  return results;
}

/**
 * Display a table of package versions.
 * Returns the number of packages with available updates.
 */
export function displayUpdateTable(updates: PackageVersion[]): number {
  let updateable = 0;

  for (const pkg of updates) {
    const hasUpdate = pkg.current !== null && pkg.current !== pkg.latest;
    const notInstalled = pkg.current === null;

    if (hasUpdate) updateable++;

    const name = pkg.name.padEnd(30);
    const current = (pkg.current ?? 'not installed').padEnd(10);
    const latest = pkg.latest;

    if (hasUpdate) {
      console.log(`  ${chalk.cyan(name)} ${chalk.yellow(current)} → ${chalk.green(latest)}`);
    } else if (notInstalled) {
      console.log(`  ${chalk.gray(name)} ${chalk.gray(current)}   ${chalk.gray(latest)}`);
    } else {
      console.log(`  ${chalk.green(name)} ${current}   ${chalk.green('✓ up to date')}`);
    }
  }

  return updateable;
}

/**
 * Run npm install -g to update the CLI package.
 * Returns true on success, or throws with the npm error message on failure.
 */
export function runGlobalInstall(): boolean {
  try {
    _exec('npm install -g @agentoctopus/cli@latest --force', { encoding: 'utf8', stdio: 'pipe', timeout: 120000 });
    return true;
  } catch (err) {
    const stderr = (err as NodeJS.ErrnoException & { stderr?: string }).stderr ?? '';
    const message = stderr.split('\n').find(l => l.startsWith('npm error')) ?? String(err);
    throw new Error(message);
  }
}
