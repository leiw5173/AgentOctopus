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

      // LPAC read-access gap (run-2 fix): production stages the skill copy AND
      // the trusted runtime closure (node.exe + bootstrap.cjs + undici) under a
      // tree it grants. This test points --node at the HOST process.execPath,
      // whose install dir the LPAC token almost certainly cannot read/execute —
      // CreateProcess then fails with ACCESS_DENIED (0x80070005) and the helper
      // relays exit 1, indistinguishable from the child exiting 1. Grant
      // READ+EXECUTE on node.exe's install dir too so the LPAC child can load
      // the runtime. grant-acl takes a directory, so pass path.dirname(node).
      const nodeDir = path.dirname(node);
      const gNode = await run(EXE, ['grant-acl', '--pkg', 'AgentOctopus.Sandbox.t1', '--path', nodeDir]).catch((e) => e);
      if (gNode.code !== 0) {
        // Diagnostic only — surface the grant failure but let the run proceed
        // so the run's own stderr tells us whether the grant was needed.
        console.error('[helper-run] grant-acl on nodeDir failed:',
          '\n  code=', gNode.code, '\n  stdout=', gNode.stdout, '\n  stderr=', gNode.stderr);
      }

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
      // us the error object, which carries code/stdout/stderr.
      //
      // DIAGNOSTIC (keep on the lane): the helper reports WHY a launch failed
      // on its stderr — fail_hr/fail_win32 write "octopus-sandbox-helper:
      // <context> failed (hr=0x...)" before returning 1, and the LPAC child's
      // own stderr (e.g. a node --require ACCESS_DENIED) is relayed verbatim.
      // Without printing this, an exit-1 result is opaque. Print the full
      // stdout+stderr BEFORE the assertion so the CI log shows the real cause.
      console.error('[helper-run] run result:',
        '\n  code=', r.code,
        '\n  signal=', r.signal,
        '\n  stdout=<<<', r.stdout, '>>>',
        '\n  stderr=<<<', r.stderr, '>>>');
      expect(r.code).toBe(3);
      expect(r.stdout).toContain('hi');
    } finally {
      rmSync(stage, { recursive: true, force: true });
    }
  });
});
