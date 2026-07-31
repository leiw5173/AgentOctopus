import { execFile } from 'node:child_process';
import fs from 'node:fs';
import fsp from 'node:fs/promises';
import net from 'node:net';
import os from 'node:os';
import path from 'node:path';
import { promisify } from 'node:util';
import { afterEach, describe, expect, it } from 'vitest';

import { resolvePolicy } from '../../src/policy.js';
import { SandboxConfigSchema } from '../../src/schema.js';
import { buildSnapshot, SnapshotError, verifySnapshot, type BuiltSnapshot } from '../../src/snapshot.js';
import type { SandboxSkillDescriptor } from '../../src/types.js';

const execFileAsync = promisify(execFile);
const temporaryRoots = new Set<string>();
const openServers = new Set<net.Server>();

function temporaryRoot(): string {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'octopus-identity-lane-'));
  temporaryRoots.add(root);
  return root;
}

function sourceTree(): { root: string; sourceDir: string; storeDir: string } {
  const root = temporaryRoot();
  const sourceDir = path.join(root, 'source');
  const storeDir = path.join(root, 'store');
  fs.mkdirSync(sourceDir, { recursive: true });
  return { root, sourceDir, storeDir };
}

function writeTree(sourceDir: string, files: Record<string, string>, mode = 0o644): void {
  for (const [relativePath, contents] of Object.entries(files)) {
    const target = path.join(sourceDir, relativePath);
    fs.mkdirSync(path.dirname(target), { recursive: true });
    fs.writeFileSync(target, contents);
    fs.chmodSync(target, mode);
  }
}

async function build(sourceDir: string, storeDir: string): Promise<BuiltSnapshot> {
  return buildSnapshot({
    sourceDir,
    storeDir,
    installationId: 'identity-lane-fixture',
    name: 'fixture-skill',
  });
}

async function fixtureSnapshot(files: Record<string, string>, mode = 0o644): Promise<BuiltSnapshot> {
  const fixture = sourceTree();
  writeTree(fixture.sourceDir, files, mode);
  return build(fixture.sourceDir, fixture.storeDir);
}

async function fixtureSymlinkSnapshot(target: string): Promise<BuiltSnapshot> {
  const fixture = sourceTree();
  writeTree(fixture.sourceDir, { 'target-a': 'a', 'target-b': 'b' });
  fs.symlinkSync(target, path.join(fixture.sourceDir, 'link'));
  return build(fixture.sourceDir, fixture.storeDir);
}

const grantedConfig = SandboxConfigSchema.parse({
  defaults: { memory: '64m', timeoutMs: 1_000, cpus: '0.5' },
  grants: [{
    installationId: 'installation-a',
    digest: 'sha256:current',
    hosts: ['api.example.com'],
    credentials: [{
      key: 'API_TOKEN',
      host: 'api.example.com',
      port: 443,
      scheme: 'https',
      methods: ['GET'],
      pathPrefix: '/',
      header: 'Authorization',
    }],
  }],
});

function descriptor(installationId: string, digest: string): SandboxSkillDescriptor {
  return {
    identity: {
      installationId,
      digest,
      snapshotRef: digest,
      name: 'same-display-name',
    },
    snapshotRoot: '/unused-by-policy-resolution',
    request: {
      hosts: ['api.example.com'],
      credentials: ['API_TOKEN'],
    },
  };
}

async function restoreOwnerWrite(target: string): Promise<void> {
  let stat: fs.Stats;
  try {
    stat = await fsp.lstat(target);
  } catch {
    return;
  }

  if (stat.isSymbolicLink()) return;
  await fsp.chmod(target, stat.mode | 0o700).catch(() => {});
  if (!stat.isDirectory()) return;

  await Promise.all(
    (await fsp.readdir(target).catch(() => [] as string[])).map(child => restoreOwnerWrite(path.join(target, child))),
  );
}

async function closeServer(server: net.Server): Promise<void> {
  openServers.delete(server);
  if (!server.listening) return;
  await new Promise<void>((resolve) => server.close(() => resolve()));
}

afterEach(async () => {
  await Promise.all([...openServers].map(closeServer));
  await Promise.all([...temporaryRoots].map(async (root) => {
    await restoreOwnerWrite(root);
    await fsp.rm(root, { recursive: true, force: true, maxRetries: 3, retryDelay: 20 });
  }));
  temporaryRoots.clear();
});

describe('identity and snapshot integrity lane', () => {
  it('does not apply a grant to a different installation with the same name and digest', () => {
    const policy = resolvePolicy(descriptor('installation-b', 'sha256:current'), grantedConfig);

    expect(policy.hosts).toEqual([]);
    expect(policy.credentials).toEqual([]);
  });

  it('does not apply a grant after the installation digest changes', () => {
    const policy = resolvePolicy(descriptor('installation-a', 'sha256:stale'), grantedConfig);

    expect(policy.hosts).toEqual([]);
    expect(policy.credentials).toEqual([]);
  });

  it('returns false after byte tampering', async () => {
    const snapshot = await fixtureSnapshot({ 'a.js': 'original' });
    const target = path.join(snapshot.snapshotRoot, 'a.js');
    fs.chmodSync(target, 0o644);
    fs.appendFileSync(target, 'tamper');

    await expect(verifySnapshot(snapshot.snapshotRoot, snapshot.identity.digest)).resolves.toBe(false);
  });

  it('returns false after rename/path tampering', async () => {
    const snapshot = await fixtureSnapshot({ 'a.js': 'same bytes' });
    fs.chmodSync(snapshot.snapshotRoot, 0o755);
    fs.renameSync(path.join(snapshot.snapshotRoot, 'a.js'), path.join(snapshot.snapshotRoot, 'b.js'));

    await expect(verifySnapshot(snapshot.snapshotRoot, snapshot.identity.digest)).resolves.toBe(false);
  });

  it('returns false after executable-mode tampering', async () => {
    const snapshot = await fixtureSnapshot({ 'run.js': 'process.exit(0)' }, 0o555);
    const target = path.join(snapshot.snapshotRoot, 'run.js');
    fs.chmodSync(snapshot.snapshotRoot, 0o755);
    fs.chmodSync(target, 0o644);

    await expect(verifySnapshot(snapshot.snapshotRoot, snapshot.identity.digest)).resolves.toBe(false);
  });

  it('returns false after an in-root symlink target changes', async () => {
    const snapshot = await fixtureSymlinkSnapshot('target-a');
    const link = path.join(snapshot.snapshotRoot, 'link');
    fs.chmodSync(snapshot.snapshotRoot, 0o755);
    fs.unlinkSync(link);
    fs.symlinkSync('target-b', link);

    await expect(verifySnapshot(snapshot.snapshotRoot, snapshot.identity.digest)).resolves.toBe(false);
  });

  it('rejects a hard link at build time', async () => {
    const fixture = sourceTree();
    writeTree(fixture.sourceDir, { a: 'x' });
    fs.linkSync(path.join(fixture.sourceDir, 'a'), path.join(fixture.sourceDir, 'b'));

    await expect(build(fixture.sourceDir, fixture.storeDir)).rejects.toThrow(/hard link/i);
  });

  // vitest v1's it.each never passes a test context, so `context.skip()`
  // below would crash on undefined — use the function-form skip option
  // (verified working in v1.6.1) instead of the dead win32 ctx.skip branch.
  it.each(['escaping-symlink', 'fifo', 'unix-socket'] as const)(
    'rejects %s at build time',
    { skip: (kind: string) => process.platform === 'win32' && kind !== 'escaping-symlink' },
    async (kind) => {

    const fixture = sourceTree();
    if (kind === 'escaping-symlink') {
      const outside = path.join(fixture.root, 'outside');
      fs.writeFileSync(outside, 'outside');
      fs.symlinkSync(outside, path.join(fixture.sourceDir, 'escape'));
    } else if (kind === 'fifo') {
      await execFileAsync('mkfifo', [path.join(fixture.sourceDir, 'fifo')]);
    } else {
      const socketPath = path.join(fixture.sourceDir, 'socket');
      const server = net.createServer();
      openServers.add(server);
      await new Promise<void>((resolve, reject) => {
        server.once('error', reject);
        server.listen(socketPath, resolve);
      });
    }

    await expect(build(fixture.sourceDir, fixture.storeDir)).rejects.toBeInstanceOf(SnapshotError);
  });

  it('produces different digests for the same bytes under different relative paths', async () => {
    const left = sourceTree();
    const right = sourceTree();
    writeTree(left.sourceDir, { 'a/file.js': 'same bytes' });
    writeTree(right.sourceDir, { 'b/file.js': 'same bytes' });

    const [a, b] = await Promise.all([
      build(left.sourceDir, left.storeDir),
      build(right.sourceDir, right.storeDir),
    ]);
    expect(a.identity.digest).not.toBe(b.identity.digest);
  });

  it('produces different digests when executable mode changes', async () => {
    const regular = sourceTree();
    const executable = sourceTree();
    writeTree(regular.sourceDir, { 'file.js': 'same bytes' }, 0o644);
    writeTree(executable.sourceDir, { 'file.js': 'same bytes' }, 0o755);

    const [a, b] = await Promise.all([
      build(regular.sourceDir, regular.storeDir),
      build(executable.sourceDir, executable.storeDir),
    ]);
    expect(a.identity.digest).not.toBe(b.identity.digest);
  });

  it('produces different digests when a symlink target changes', async () => {
    const targetA = sourceTree();
    const targetB = sourceTree();
    writeTree(targetA.sourceDir, { 'target-a': 'a', 'target-b': 'b' });
    writeTree(targetB.sourceDir, { 'target-a': 'a', 'target-b': 'b' });
    fs.symlinkSync('target-a', path.join(targetA.sourceDir, 'link'));
    fs.symlinkSync('target-b', path.join(targetB.sourceDir, 'link'));

    const [a, b] = await Promise.all([
      build(targetA.sourceDir, targetA.storeDir),
      build(targetB.sourceDir, targetB.storeDir),
    ]);
    expect(a.identity.digest).not.toBe(b.identity.digest);
  });

  it('produces identical digests for independently rebuilt identical trees', async () => {
    const left = sourceTree();
    const right = sourceTree();
    writeTree(left.sourceDir, { 'lib/file.js': 'same bytes', 'README.txt': 'same metadata' }, 0o644);
    writeTree(right.sourceDir, { 'lib/file.js': 'same bytes', 'README.txt': 'same metadata' }, 0o644);

    const [a, b] = await Promise.all([
      build(left.sourceDir, left.storeDir),
      build(right.sourceDir, right.storeDir),
    ]);
    expect(a.identity.digest).toBe(b.identity.digest);
  });
});
