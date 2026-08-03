import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import crypto from 'node:crypto';
import {
  verifyDarwinRuntimeManifest,
  darwinRuntimeNodeArgs,
  type DarwinRuntimeManifest,
} from '../src/os/darwin/runtime-manifest.js';

let tmp: string;

function sha256(p: string): string {
  return crypto.createHash('sha256').update(fs.readFileSync(p)).digest('hex');
}

interface FixtureEntry { path: string; sha256: string; size: number; mode: number; }

function makeFile(rel: string, content: string, mode = 0o755): FixtureEntry {
  const abs = path.join(tmp, rel);
  fs.mkdirSync(path.dirname(abs), { recursive: true });
  fs.writeFileSync(abs, content);
  fs.chmodSync(abs, mode);
  const st = fs.statSync(abs);
  return { path: abs, sha256: sha256(abs), size: st.size, mode: st.mode & 0o7777 };
}

function writeManifest(m: Partial<DarwinRuntimeManifest>): string {
  const mp = path.join(tmp, 'manifest.json');
  fs.writeFileSync(mp, JSON.stringify(m, null, 2));
  return mp;
}

function baseManifest(): DarwinRuntimeManifest {
  const exe = makeFile('bin/node', 'fake-node-binary');
  const dylib = makeFile('lib/libnode.dylib', 'fake-dylib');
  const data = makeFile('share/icu/icudt.dat', 'fake-icu-data', 0o644);
  return {
    schemaVersion: 1,
    executablePath: exe.path,
    sha256: exe.sha256,
    size: exe.size,
    mode: exe.mode,
    dylibs: [{ path: dylib.path, sha256: dylib.sha256, size: dylib.size, mode: dylib.mode }],
    dataFiles: [{ path: data.path, sha256: data.sha256, size: data.size, mode: data.mode }],
    machServices: ['com.apple.system.opendirectoryd.libinfo'],
    sysctls: ['kern.osproductversion'],
    jitPolicy: 'jitless',
  };
}

beforeEach(() => {
  tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'darwin-manifest-'));
});

afterEach(() => {
  fs.rmSync(tmp, { recursive: true, force: true });
});

describe('verifyDarwinRuntimeManifest', () => {
  it('verifies digest/size/mode for executable, dylibs, and data files', async () => {
    const m = baseManifest();
    const result = await verifyDarwinRuntimeManifest(writeManifest(m));
    expect(result.schemaVersion).toBe(1);
    expect(result.executablePath).toBe(m.executablePath);
    expect(result.dylibs).toHaveLength(1);
    expect(result.dataFiles).toHaveLength(1);
    expect(result.jitPolicy).toBe('jitless');
  });

  it('returns a frozen result', async () => {
    const result = await verifyDarwinRuntimeManifest(writeManifest(baseManifest()));
    expect(Object.isFrozen(result)).toBe(true);
    expect(Object.isFrozen(result.dylibs)).toBe(true);
  });

  it('throws on tampered dylib digest', async () => {
    const m = baseManifest();
    fs.appendFileSync(m.dylibs[0]!.path, 'tampered'); // changes content + size
    await expect(verifyDarwinRuntimeManifest(writeManifest(m))).rejects.toThrow();
  });

  it('throws on flipped single byte of a data file', async () => {
    const m = baseManifest();
    const p = m.dataFiles[0]!.path;
    const buf = fs.readFileSync(p);
    buf[0] = buf[0]! ^ 0xff;
    fs.writeFileSync(p, buf); // same size, different digest
    await expect(verifyDarwinRuntimeManifest(writeManifest(m))).rejects.toThrow();
  });

  it('throws on group/world-writable entry', async () => {
    const m = baseManifest();
    fs.chmodSync(m.dylibs[0]!.path, 0o646); // world-writable
    await expect(verifyDarwinRuntimeManifest(writeManifest(m))).rejects.toThrow();
  });

  it('throws on missing file', async () => {
    const m = baseManifest();
    fs.unlinkSync(m.dylibs[0]!.path);
    await expect(verifyDarwinRuntimeManifest(writeManifest(m))).rejects.toThrow();
  });

  it('requires jitPolicy jitless|dynamic-code-generation', async () => {
    const m = baseManifest();
    // @ts-expect-error deliberately invalid
    m.jitPolicy = 'auto';
    await expect(verifyDarwinRuntimeManifest(writeManifest(m))).rejects.toThrow();
  });

  it('rejects unknown schemaVersion', async () => {
    const m = baseManifest();
    // @ts-expect-error deliberately invalid
    m.schemaVersion = 2;
    await expect(verifyDarwinRuntimeManifest(writeManifest(m))).rejects.toThrow();
  });

  it('rejects non-exact machServices entries', async () => {
    const m = baseManifest();
    m.machServices = ['com.apple.*'];
    await expect(verifyDarwinRuntimeManifest(writeManifest(m))).rejects.toThrow();
  });

  it('rejects non-exact sysctls entries', async () => {
    const m = baseManifest();
    m.sysctls = ['kern.*'];
    await expect(verifyDarwinRuntimeManifest(writeManifest(m))).rejects.toThrow();
  });

  it('rejects a non-absolute executablePath', async () => {
    const m = baseManifest();
    m.executablePath = 'bin/node';
    await expect(verifyDarwinRuntimeManifest(writeManifest(m))).rejects.toThrow();
  });
});

describe('darwinRuntimeNodeArgs', () => {
  it('returns ["--jitless"] when jitless', () => {
    expect(darwinRuntimeNodeArgs(baseManifest())).toEqual(['--jitless']);
  });

  it('returns [] for dynamic-code-generation', () => {
    const m = baseManifest();
    m.jitPolicy = 'dynamic-code-generation';
    expect(darwinRuntimeNodeArgs(m)).toEqual([]);
  });
});
