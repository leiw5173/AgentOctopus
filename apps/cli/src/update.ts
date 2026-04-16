import { execSync } from 'child_process';
import chalk from 'chalk';

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
 * Query npm registry for the latest version of a package.
 * Returns null if the package is not found or the registry is unreachable.
 */
export async function getLatestVersion(pkg: string): Promise<string | null> {
  try {
    const result = execSync(`npm view ${pkg} version`, { encoding: 'utf8', timeout: 15000 }).trim();
    return result || null;
  } catch {
    return null;
  }
}

/**
 * Get the currently installed version of a package.
 * Uses `npm list -g` to read the global install.
 * Returns null if the package is not installed globally.
 */
export function getInstalledVersion(pkg: string): string | null {
  try {
    const result = execSync(`npm list -g ${pkg} --json`, { encoding: 'utf8', timeout: 10000 }).trim();
    const data = JSON.parse(result);
    // npm list -g returns { "dependencies": { "@agentoctopus/cli": { "version": "0.4.15" } } }
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
 * Returns true on success.
 */
export function runGlobalInstall(): boolean {
  try {
    execSync('npm install -g @agentoctopus/cli@latest', { encoding: 'utf8', stdio: 'pipe', timeout: 120000 });
    return true;
  } catch {
    return false;
  }
}
