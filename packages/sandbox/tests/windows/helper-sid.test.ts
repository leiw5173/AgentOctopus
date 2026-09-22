// packages/sandbox/tests/windows/helper-sid.test.ts
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
import { existsSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const run = promisify(execFile);

const HERE = path.dirname(fileURLToPath(import.meta.url));
const EXE = path.join(HERE, '..', '..', 'prebuilds', 'windows-x64', 'octopus-sandbox-helper.exe');

// Skip when not on Windows OR when the helper has not been built yet.
const itWin = (process.platform === 'win32' && existsSync(EXE)) ? it : it.skip;

describe('helper sid/probe', () => {
  itWin('derives a loopback capability SID', async () => {
    const { stdout } = await run(EXE, ['sid', 'AgentOctopus.Sandbox.test']);
    // Capability SIDs are S-1-15-3-* (RID 3 = SECURITY_CAPABILITY_BASE_RID).
    // The loopback capability is derived by copying the package SID
    // (S-1-15-2-*) and rewriting the first sub-authority from
    // SECURITY_APP_PACKAGE_BASE_RID (2) to SECURITY_CAPABILITY_BASE_RID (3).
    expect(stdout.trim()).toMatch(/^S-1-15-3-/);
  });

  itWin('probe self-test passes', async () => {
    const { stdout } = await run(EXE, ['probe']);
    expect(stdout).toMatch(/OK/);
  });
});
