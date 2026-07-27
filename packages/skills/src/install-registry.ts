/**
 * Strict installation-identity store.
 *
 * Every installed skill gets a stable, host-generated `installationId` that is
 * one half of the sandbox grant key (the other half is the snapshot digest).
 * Identity is created ONLY at install time via `ensureInstallationId`. The
 * execution path uses `lookupInstallationId`, which throws
 * `INSTALLATION_ID_MISSING` when no identity exists — execution must never
 * create identity metadata.
 *
 * Storage: a JSON file `.installation-id.json` in the skill's `dirPath`,
 * written atomically (tmp + rename) with mode 0600.
 */
import fs from 'node:fs';
import path from 'node:path';
import crypto from 'node:crypto';

export const INSTALLATION_ID_MISSING = 'INSTALLATION_ID_MISSING';

const IDENTITY_FILENAME = '.installation-id.json';

interface IdentityFile {
  installationId: string;
}

function identityPath(dirPath: string): string {
  return path.join(dirPath, IDENTITY_FILENAME);
}

function readIdentity(dirPath: string): IdentityFile | undefined {
  const file = identityPath(dirPath);
  if (!fs.existsSync(file)) return undefined;
  try {
    const raw = fs.readFileSync(file, 'utf-8');
    const parsed = JSON.parse(raw) as Partial<IdentityFile>;
    if (typeof parsed.installationId !== 'string' || parsed.installationId.length === 0) {
      return undefined;
    }
    return { installationId: parsed.installationId };
  } catch {
    return undefined;
  }
}

function writeIdentityAtomic(dirPath: string, identity: IdentityFile): void {
  const file = identityPath(dirPath);
  const tmp = `${file}.tmp-${process.pid}-${Date.now()}`;
  const body = JSON.stringify(identity, null, 2);
  fs.writeFileSync(tmp, body, { mode: 0o600 });
  fs.renameSync(tmp, file);
  // Re-apply mode in case the rename target previously existed with broader perms.
  fs.chmodSync(file, 0o600);
}

/**
 * Create-and-persist (or return existing) installation id for an installed
 * skill. INSTALL PATHS ONLY — never call from execution.
 */
export function ensureInstallationId(dirPath: string): string {
  const existing = readIdentity(dirPath);
  if (existing) return existing.installationId;
  const identity: IdentityFile = { installationId: crypto.randomUUID() };
  writeIdentityAtomic(dirPath, identity);
  return identity.installationId;
}

/**
 * Strict read of an existing installation id. Throws with `code =
 * INSTALLATION_ID_MISSING` when none exists. NEVER calls
 * `ensureInstallationId` — execution must never create identity metadata.
 */
export function lookupInstallationId(dirPath: string): string {
  const existing = readIdentity(dirPath);
  if (!existing) {
    const err = new Error(
      `installation id missing for skill at ${dirPath} — run install to create one`,
    ) as NodeJS.ErrnoException & { code: string };
    err.code = INSTALLATION_ID_MISSING;
    throw err;
  }
  return existing.installationId;
}

/** Remove any persisted installation id. No-op when absent. */
export function removeInstallationId(dirPath: string): void {
  const file = identityPath(dirPath);
  try {
    fs.rmSync(file, { force: true });
  } catch {
    // best-effort
  }
}
