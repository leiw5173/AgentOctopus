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
import { existsSync, mkdtempSync, writeFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
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

    // The helper injects NODE_OPTIONS="--require <bootstrap>" into the child
    // (build_child_environment), so --bootstrap MUST point at a real, loadable
    // CommonJS module. The previous `C:\nul` placeholder made the child node
    // fail to --require it and exit 1 before the -e script ever ran — the
    // helper faithfully relayed that exit 1, masking the real assertion.
    // Stage a minimal empty bootstrap (and a real CA file) in a temp dir so
    // the child actually runs `process.exit(3)` and the helper relays 3.
    const stage = mkdtempSync(path.join(tmpdir(), 'oct-helper-run-'));
    try {
      const bootstrap = path.join(stage, 'bootstrap.cjs');
      const ca = path.join(stage, 'ca.pem');
      writeFileSync(bootstrap, '// empty bootstrap for helper-run test\n');
      writeFileSync(ca, '');

      // The child runs as an AppContainer LPAC token, which by default cannot
      // read arbitrary user-profile temp paths. Production grants the LPAC
      // SIDs READ access via WinSandboxBackend.prepare -> grantRead; mirror
      // that here so the child can --require the staged bootstrap (and read
      // the CA). Without the grant the LPAC child gets ACCESS_DENIED reading
      // the bootstrap and exits non-zero before the -e script runs.
      await run(EXE, ['grant-acl', '--pkg', 'AgentOctopus.Sandbox.t1', '--path', stage]);

      const r = await run(EXE, [
        'run',
        '--job', 'OctJob-t1',
        '--mem-mb', '256',
        '--pkg', 'AgentOctopus.Sandbox.t1',
        '--proxy', '127.0.0.1:1',
        '--ca', ca,
        '--bootstrap', bootstrap,
        '--node', node,
        '--',
        '-e', "process.stdout.write('hi');process.exit(3)",
      ]).catch((e) => e);
      // execFile rejects when the child exits non-zero; the .catch above hands
      // us the error object, which carries code/stdout.
      expect(r.code).toBe(3);
      expect(r.stdout).toContain('hi');
    } finally {
      rmSync(stage, { recursive: true, force: true });
    }
  });
});
