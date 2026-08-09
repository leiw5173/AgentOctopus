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
import { execFile, spawn } from 'node:child_process';
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

// Run the helper with spawn() so stdout/stderr STREAM live into the test as
// chunks arrive (execFile only yields output on child exit, so a hung helper
// showed nothing). We mirror each chunk to console.error immediately AND
// accumulate it, so a hang localizes to the last "[run] <stage>" marker in
// the CI log. Resolves with {code, signal, stdout, stderr} on exit; on a
// spawn-level error (e.g. ENOENT) code is -1.
function runHelperStreaming(
  args: string[],
): Promise<{ code: number | null; signal: string | null; stdout: string; stderr: string }> {
  return new Promise((resolve) => {
    const child = spawn(EXE, args, { stdio: ['ignore', 'pipe', 'pipe'] });
    let stdout = '';
    let stderr = '';
    child.stdout.on('data', (d: Buffer) => {
      const s = d.toString('utf8');
      stdout += s;
      process.stderr.write(`[helper stdout] ${s}`);
    });
    child.stderr.on('data', (d: Buffer) => {
      const s = d.toString('utf8');
      stderr += s;
      process.stderr.write(`[helper stderr] ${s}`);
    });
    child.on('error', (e) => {
      process.stderr.write(`[helper spawn error] ${String(e)}\n`);
      resolve({ code: -1, signal: null, stdout, stderr });
    });
    child.on('close', (code, signal) => {
      resolve({ code, signal, stdout, stderr });
    });
  });
}

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

      // ------------------------------------------------------------------
      // RUN-5 CONTROLLED EXPERIMENT, arm 1: the LPAC self-test child.
      //
      // `run --selftest` launches the helper EXE ITSELF running the minimal
      // `run-probe-child` subcommand (no V8, no --require bootstrap execution;
      // it writes a stderr liveness marker and ExitProcess(3)es) under the
      // IDENTICAL LPAC token + Job. This isolates the crash cause in ONE run:
      //   - self-test relays exit 3 + the liveness marker, but the node arm
      //     (below) fastfails 0x80000003  => node.exe / V8 init under LPAC is
      //     the culprit, NOT the token / Job / file access.
      //   - self-test ALSO fastfails 0x80000003  => the LPAC token / file
      //     access itself is broken independent of node.
      //
      // The self-test child IS the helper exe, so the LPAC token must be able
      // to read/execute it: grant READ+EXECUTE on the helper's own dir first.
      // ------------------------------------------------------------------
      await run(EXE, ['grant-acl', '--pkg', 'AgentOctopus.Sandbox.t1', '--path', path.dirname(EXE)]).catch(() => {});
      const selftest = await runHelperStreaming([
        'run', '--selftest',
        '--job', 'OctJob-t1-selftest',
        '--mem-mb', '256',
        '--pkg', 'AgentOctopus.Sandbox.t1',
        '--proxy', '127.0.0.1:1',
        '--ca', ca,
        '--bootstrap', bootstrap,
        '--node', node,
      ]);
      console.error('[helper-run] SELFTEST (run-probe-child) result:',
        '\n  code=', selftest.code,
        '\n  signal=', selftest.signal,
        '\n  stdout=<<<', selftest.stdout, '>>>',
        '\n  stderr=<<<', selftest.stderr, '>>>');
      // 0x80000003 (STATUS_BREAKPOINT) as an unsigned DWORD is 2147483651; as
      // a signed 32-bit int (what Node's exit 'code' surfaces) it is
      // -2147483645. Report which arm crashed so the log is unambiguous.
      const SELFTEST_CRASH = selftest.code === 2147483651 || selftest.code === -2147483645;
      console.error('[helper-run] SELFTEST outcome:',
        SELFTEST_CRASH
          ? 'CRASHED 0x80000003 -> LPAC token/file-access broken (node-independent)'
          : selftest.code === 3
            ? 'RAN CLEAN (exit 3) -> LPAC+Job viable; node/V8 is the crash cause'
            : `unexpected exit ${selftest.code}`);

      // ------------------------------------------------------------------
      // arm 2: the real node.exe LPAC child (the original assertion).
      // ------------------------------------------------------------------
      const r = await runHelperStreaming([
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
      ]);
      // The helper now emits "[run] <stage>" markers on stderr at each major
      // step of launch_sandboxed, and runHelperStreaming mirrors them live.
      // If this test times out, the LAST marker printed before the timeout is
      // the stage where the helper blocked (e.g. "[run] relay loop entered"
      // with no "[run] child exited"/"[run] * pipe eof" => the EOF/grandchild
      // handle theory is confirmed). Print the accumulated buffers too so the
      // full capture is in the CI log even if mirroring interleaved oddly.
      console.error('[helper-run] run result:',
        '\n  code=', r.code,
        '\n  signal=', r.signal,
        '\n  stdout=<<<', r.stdout, '>>>',
        '\n  stderr=<<<', r.stderr, '>>>');
      const NODE_CRASH = r.code === 2147483651 || r.code === -2147483645;
      console.error('[helper-run] NODE-ARM outcome:',
        NODE_CRASH
          ? 'CRASHED 0x80000003 (STATUS_BREAKPOINT / __fastfail int3)'
          : `exit ${r.code}`);
      expect(r.code).toBe(3);
      expect(r.stdout).toContain('hi');
    } finally {
      rmSync(stage, { recursive: true, force: true });
    }
  }, 60_000); // generous timeout: a slow CI runner must not false-timeout, and
              // a real hang yields 60s of streamed stage markers before failing.
});
