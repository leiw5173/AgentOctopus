// packages/sandbox/tests/windows/helper-run.test.ts
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

describe('helper run', () => {
  itWin('runs a command and relays stdout + exit code', async () => {
    // node -e "process.stdout.write('hi'); process.exit(3)"
    // On Windows CI, process.execPath is the trusted Node; the helper's
    // --node flag resolves to it verbatim.
    const node = process.execPath;
    const r = await run(EXE, [
      'run',
      '--job', 'OctJob-t1',
      '--mem-mb', '256',
      '--pkg', 'AgentOctopus.Sandbox.t1',
      '--proxy', '127.0.0.1:1',
      '--ca', 'C:\\nul',
      '--bootstrap', 'C:\\nul',
      '--node', node,
      '--',
      '-e', "process.stdout.write('hi');process.exit(3)",
    ]).catch((e) => e);
    // execFile rejects when the child exits non-zero; the .catch above hands
    // us the error object, which carries code/stdout.
    expect(r.code).toBe(3);
    expect(r.stdout).toContain('hi');
  });
});
