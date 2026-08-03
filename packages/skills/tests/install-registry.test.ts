import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import {
  ensureInstallationId,
  lookupInstallationId,
  removeInstallationId,
  INSTALLATION_ID_MISSING,
} from '../src/install-registry.js';

let dir: string;

beforeEach(() => {
  dir = fs.mkdtempSync(path.join(os.tmpdir(), 'oct-install-id-'));
});

afterEach(() => {
  fs.rmSync(dir, { recursive: true, force: true });
});

describe('ensureInstallationId', () => {
  it('creates and persists an installation id in the skill dir', () => {
    const id = ensureInstallationId(dir);
    expect(typeof id).toBe('string');
    expect(id.length).toBeGreaterThan(0);
    const file = path.join(dir, '.installation-id.json');
    expect(fs.existsSync(file)).toBe(true);
    const parsed = JSON.parse(fs.readFileSync(file, 'utf-8'));
    expect(parsed.installationId).toBe(id);
  });

  it('returns the same id on repeated ensure (idempotent)', () => {
    const first = ensureInstallationId(dir);
    const second = ensureInstallationId(dir);
    expect(second).toBe(first);
  });

  it('writes the file with mode 0600', () => {
    ensureInstallationId(dir);
    const file = path.join(dir, '.installation-id.json');
    const mode = fs.statSync(file).mode & 0o777;
    expect(mode).toBe(0o600);
  });
});

describe('lookupInstallationId', () => {
  it('throws INSTALLATION_ID_MISSING when no identity has been created', () => {
    expect(() => lookupInstallationId(dir)).toThrowError();
    try {
      lookupInstallationId(dir);
      expect.unreachable('should have thrown');
    } catch (err: any) {
      expect(err.code).toBe(INSTALLATION_ID_MISSING);
    }
  });

  it('returns the same id previously created via ensure', () => {
    const id = ensureInstallationId(dir);
    expect(lookupInstallationId(dir)).toBe(id);
  });

  it('does not create identity metadata on lookup (execution never creates identity)', () => {
    expect(() => lookupInstallationId(dir)).toThrowError();
    expect(fs.existsSync(path.join(dir, '.installation-id.json'))).toBe(false);
  });
});

describe('removeInstallationId', () => {
  it('removes the identity file so subsequent lookups throw', () => {
    ensureInstallationId(dir);
    removeInstallationId(dir);
    expect(() => lookupInstallationId(dir)).toThrowError();
    expect(fs.existsSync(path.join(dir, '.installation-id.json'))).toBe(false);
  });

  it('is a no-op when no identity exists', () => {
    expect(() => removeInstallationId(dir)).not.toThrow();
  });
});
