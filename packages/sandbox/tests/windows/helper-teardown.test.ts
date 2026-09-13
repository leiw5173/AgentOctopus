// packages/sandbox/tests/windows/helper-teardown.test.ts
//
// Drives the BUILT octopus-sandbox-helper.exe produced by
// scripts/build-win-helper.mjs. The exe is a Windows PE binary and only
// exists after a successful build on a Windows host with MSVC cl.exe.
//
// On any non-Windows host (and on Windows when the exe has not been built
// yet) every test in this file SKIPS cleanly — it must never fail, crash,
// or leave the test runner waiting on a missing binary.
import { describe, it, expect } from 'vitest';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { existsSync, mkdtempSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const run = promisify(execFile);

const HERE = path.dirname(fileURLToPath(import.meta.url));
const EXE = path.join(HERE, '..', '..', 'prebuilds', 'windows-x64', 'octopus-sandbox-helper.exe');

// Skip when not on Windows OR when the helper has not been built yet.
const itWin = (process.platform === 'win32' && existsSync(EXE)) ? it : it.skip;

describe('helper grant-acl/teardown', () => {
  itWin('grant-acl then teardown removes the copy dir', async () => {
    const dir = mkdtempSync(path.join(tmpdir(), 'octcopy-'));
    writeFileSync(path.join(dir, 'f.txt'), 'x');
    // Grant the package's LPAC SIDs READ+EXECUTE on the staged copy dir.
    await run(EXE, ['grant-acl', '--pkg', 'AgentOctopus.Sandbox.td', '--path', dir]);
    // Teardown: the Job 'OctJob-td' does not exist, which teardown must
    // treat as already-dead (proceed to profile + copydir deletion).
    await run(EXE, ['teardown', '--job', 'OctJob-td', '--pkg', 'AgentOctopus.Sandbox.td', '--copydir', dir]);
    expect(existsSync(dir)).toBe(false);
  });
});
