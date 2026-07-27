import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { installFromIndex, type SkillIndexEntry } from '../src/clawhub-install.js';
import {
  lookupInstallationId,
  ensureInstallationId,
  removeInstallationId,
  peekInstallationId,
  restoreInstallationId,
} from '../src/install-registry.js';

let dir: string;

function makeEntry(slug: string, version = '1.0.0'): SkillIndexEntry {
  return {
    slug,
    name: slug,
    description: `desc for ${slug}`,
    version,
    author: 'tester',
    skillMd: `---\nname: ${slug}\nversion: ${version}\n---\n\n# ${slug}\n`,
    metaJson: '{}',
    invokeScript: 'console.log("hi");',
    scripts: null,
    files: null,
  };
}

function idOf(slug: string): string {
  return lookupInstallationId(path.join(dir, slug));
}

beforeEach(() => {
  dir = fs.mkdtempSync(path.join(os.tmpdir(), 'oct-clawhub-id-'));
});

afterEach(() => {
  fs.rmSync(dir, { recursive: true, force: true });
});

describe('installFromIndex installation-id lifecycle', () => {
  it('new install A → id1', () => {
    installFromIndex(makeEntry('skill-a'), dir);
    const id = idOf('skill-a');
    expect(typeof id).toBe('string');
    expect(id.length).toBeGreaterThan(0);
  });

  it('force reinstall A → id1 preserved', () => {
    installFromIndex(makeEntry('skill-a'), dir);
    const id1 = idOf('skill-a');
    installFromIndex(makeEntry('skill-a', '2.0.0'), dir, true); // force
    expect(idOf('skill-a')).toBe(id1);
  });

  it('sync replace (force) A → id1 preserved', () => {
    installFromIndex(makeEntry('skill-a'), dir);
    const id1 = idOf('skill-a');
    // applySkillUpdates delegates to installFromIndex(entry, dir, true)
    installFromIndex(makeEntry('skill-a', '1.5.0'), dir, true);
    expect(idOf('skill-a')).toBe(id1);
  });

  it('import over A (non-force patch) → id1 preserved', () => {
    installFromIndex(makeEntry('skill-a'), dir);
    const id1 = idOf('skill-a');
    // Non-force patch path: add a missing file without --force
    const patch = makeEntry('skill-a');
    patch.files = { 'docs/extra.md': '# extra' };
    installFromIndex(patch, dir, false);
    expect(idOf('skill-a')).toBe(id1);
    expect(fs.existsSync(path.join(dir, 'skill-a', 'docs', 'extra.md'))).toBe(true);
  });

  it('failed replacement A → id1 and old directory intact', () => {
    installFromIndex(makeEntry('skill-a'), dir);
    const id1 = idOf('skill-a');
    const skillDir = path.join(dir, 'skill-a');
    // A malformed entry (no SKILL.md) must throw WITHOUT wiping the existing dir.
    const bad = makeEntry('skill-a');
    bad.skillMd = null;
    expect(() => installFromIndex(bad, dir, true)).toThrow();
    expect(idOf('skill-a')).toBe(id1);
    expect(fs.existsSync(path.join(skillDir, 'SKILL.md'))).toBe(true);
  });

  it('uninstall A; fresh reinstall A → id2 !== id1 (rotation)', () => {
    installFromIndex(makeEntry('skill-a'), dir);
    const id1 = idOf('skill-a');
    // Uninstall: remove id then the directory (mirrors CLI remove / stale-delete)
    const skillDir = path.join(dir, 'skill-a');
    removeInstallationId(skillDir);
    fs.rmSync(skillDir, { recursive: true, force: true });
    // Fresh reinstall
    installFromIndex(makeEntry('skill-a'), dir);
    const id2 = idOf('skill-a');
    expect(id2).not.toBe(id1);
  });

  it('new install B → idB !== id1', () => {
    installFromIndex(makeEntry('skill-a'), dir);
    installFromIndex(makeEntry('skill-b'), dir);
    expect(idOf('skill-b')).not.toBe(idOf('skill-a'));
  });
});

describe('peek/restore round-trip', () => {
  it('peek returns undefined when no identity, then the id after ensure', () => {
    const skillDir = path.join(dir, 'skill-x');
    fs.mkdirSync(skillDir, { recursive: true });
    expect(peekInstallationId(skillDir)).toBeUndefined();
    const id = ensureInstallationId(skillDir);
    expect(peekInstallationId(skillDir)).toBe(id);
  });

  it('restore persists a specific id retrievable via lookup', () => {
    const skillDir = path.join(dir, 'skill-y');
    fs.mkdirSync(skillDir, { recursive: true });
    restoreInstallationId(skillDir, 'fixed-id-123');
    expect(lookupInstallationId(skillDir)).toBe('fixed-id-123');
  });
});
