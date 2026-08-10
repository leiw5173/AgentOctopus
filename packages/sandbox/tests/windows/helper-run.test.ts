// packages/sandbox/tests/windows/helper-run.test.ts
//
// RUN-6 ROOT-CAUSE MATRIX (single-variable experiment).
//
// Background (windows-run5-lpac-crash-report.md): the LPAC+Job sandbox
// mechanism is PROVEN correct — a minimal no-V8 child (the helper exe via
// `run-probe-child`) runs clean under the FULL LPAC token + Job and exits 3.
// node.exe (v22) under the SAME LPAC token + Job fast-fails immediately with
// exit 0x80000003 (STATUS_BREAKPOINT / __fastfail int3), writing nothing to
// stdout or stderr. So node/V8 init is incompatible with the LPAC+Job
// environment — but the run-5 experiment did NOT isolate WHICH layer triggers
// it (the V8 sandbox's ~1TB reservation, the Job memory limit, dynamic-code
// policy / ACG, CFG, the Wasm trap handler, LPAC alone, or a combination).
//
// This test runs a controlled single-variable matrix in ONE CI run. Each arm
// removes exactly ONE layer (or adds exactly ONE node flag) so the arm that
// flips the outcome from CRASH to PASS localizes the trigger:
//
//   arm=baseline            node + LPAC + Job + memlimit      (expect CRASH)
//   arm=noJob               node + LPAC, NO Job               -> Job trigger?
//   arm=noLpac              node + Job + memlimit, NO LPAC    -> LPAC trigger?
//   arm=noJobMemLimit       node + LPAC + Job, NO mem limit   -> commit cap?
//   arm=jitless             node + LPAC + Job + --jitless     -> ACG/JIT?
//   arm=noWasmTrapHandler   node + LPAC + Job +               -> Wasm trap?
//                             --disable-wasm-trap-handler
//
// Each arm independently logs one `[MATRIX] arm=<name> -> ...` result line so
// the CI log carries the full decision table even though the test does not
// assert the (currently unfixed) crash.
//
// LANE-HONESTY CONTRACT (assert-no-skipped-tests.mjs): this test must NEVER
// skip on the Windows lane and must NOT hard-fail while we are still
// diagnosing — its job THIS run is DATA, not green. It therefore always
// PASSES after logging every arm, asserting only that the matrix RAN (every
// arm produced a definite exit result). It does NOT assert exit==3 / 'hi'
// yet. TODO(run-6): once the matrix identifies the trigger and a remedy is
// adopted, restore the hard baseline assertion (exit 3 + 'hi') reflecting the
// fixed behavior. Off Windows (or before the helper exe is built) the whole
// file skips cleanly via itWin — same as before.
//
// UPDATE (Option 3 adopted, Task 39): the remedy the TODO(run-6) awaited is
// Option 3 — restricted token + Job Object, no LPAC. Run-6's outcome stands
// as recorded in windows-run6-matrix-report.md: "LPAC token is the necessary
// trigger for the Node launch crash; the specific internal trigger point is
// pending crash-stack confirmation." Production node therefore launches via
// `--restricted-token` (helper.c production mode), and the HARD fail-closed
// assertions are restored in the SECOND describe block below ("Option 3
// production regression"). This matrix test itself stays diagnostic — the
// permanent record of the LPAC crash evidence — and still only asserts that
// every arm produced an exit.
import { describe, it, expect } from 'vitest';
import { execFile, spawn } from 'node:child_process';
import { promisify } from 'node:util';
import { existsSync, mkdtempSync, writeFileSync, rmSync, copyFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const run = promisify(execFile);

const HERE = path.dirname(fileURLToPath(import.meta.url));
const EXE = path.join(HERE, '..', '..', 'prebuilds', 'windows-x64', 'octopus-sandbox-helper.exe');

// Skip when not on Windows OR when the helper has not been built yet.
const itWin = (process.platform === 'win32' && existsSync(EXE)) ? it : it.skip;

// STATUS_BREAKPOINT (0x80000003) as an unsigned DWORD is 2147483651; as a
// signed 32-bit int (what Node's exit 'code' surfaces) it is -2147483645.
const isFastFail = (code: number | null): boolean =>
  code === 2147483651 || code === -2147483645;

// Run-11 (CI 31359902308): the Low-integrity restricted token cannot even
// open the host toolchain node.exe (image probes fail err=5 under
// C:\hostedtoolcache — path-based denial; the same bytes under the session
// temp dir open fine). Every direct helper-run Option-3 test therefore
// stages a node.exe COPY into the test's temp stage dir and passes the copy
// as --node — mirroring the production fix (win-backend Step 4c stages a
// session-private copy and keys the WFP gate on it). The copy keeps the
// default Medium mandatory label: readable+executable by the Low child,
// NO_WRITE_UP stops the child rewriting its own interpreter.
function stageNodeCopy(node: string, stage: string): string {
  const copy = path.join(stage, 'node.exe');
  copyFileSync(node, copy);
  return copy;
}

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

// One matrix arm. helperFlags are the run-6 diagnostic toggles (--skip-job /
// --skip-lpac / --no-job-mem-limit); nodeArgs are extra node CLI flags placed
// AFTER `--` (e.g. --jitless) before the -e script. The child script writes
// 'hi' and exits 3 so PASS == (exit 3 AND stdout contains 'hi').
interface Arm {
  name: string;
  helperFlags: string[];
  nodeArgs: string[];
}

describe('helper run (run-6 root-cause matrix)', () => {
  itWin('runs the single-variable LPAC/Job matrix and logs per-arm results', async () => {
    const node = process.execPath;

    // Stage a real loadable bootstrap + CA (build_child_environment injects
    // NODE_OPTIONS="--require <bootstrap>", so it must exist) in a temp dir.
    const stage = mkdtempSync(path.join(tmpdir(), 'oct-helper-matrix-'));
    try {
      const bootstrap = path.join(stage, 'bootstrap.cjs');
      const ca = path.join(stage, 'ca.pem');
      writeFileSync(bootstrap, '// empty bootstrap for helper-run matrix test\n');
      writeFileSync(ca, '');

      const pkg = 'AgentOctopus.Sandbox.matrix1';
      const CHILD_SCRIPT = "process.stdout.write('hi');process.exit(3)";

      // Grant the UNION of paths every arm needs (granting once up front keeps
      // each arm single-variable — only the helper/node flags differ):
      //   - the stage dir (bootstrap + CA the LPAC child must --require/read)
      //   - node.exe's install dir (the LPAC child must read/execute node)
      //   - the helper exe's own dir (harmless here; kept for symmetry with
      //     the run-5 selftest, and so a future selftest arm needs no re-grant)
      // grant-acl failures are diagnostic-only: an arm that then gets
      // ACCESS_DENIED surfaces as a distinct non-3/non-0x80000003 exit.
      for (const dir of [stage, path.dirname(node), path.dirname(EXE)]) {
        const g = await run(EXE, ['grant-acl', '--pkg', pkg, '--path', dir]).catch((e) => e);
        if (g.code !== 0) {
          console.error('[helper-matrix] grant-acl failed for', dir,
            '\n  code=', g.code, '\n  stderr=', g.stderr);
        }
      }

      // The matrix. Each arm removes exactly ONE layer or adds exactly ONE
      // node flag relative to the baseline. Arm names are stable so the
      // [MATRIX] log lines are greppable across runs.
      const arms: Arm[] = [
        // Control: full sandbox. Run-5 established this arm CRASHES 0x80000003.
        { name: 'baseline=node+lpac+job+memlimit', helperFlags: [], nodeArgs: [] },
        // LPAC present, Job absent -> if this PASSES, the Job is the trigger.
        { name: 'node+lpac+noJob', helperFlags: ['--skip-job'], nodeArgs: [] },
        // Job present, LPAC absent -> if this PASSES, LPAC is the trigger.
        { name: 'node+job+noLpac', helperFlags: ['--skip-lpac'], nodeArgs: [] },
        // Full LPAC+Job but NO per-Job commit cap -> if this PASSES, the
        // JOB_OBJECT_LIMIT_JOB_MEMORY commit cap is the trigger.
        { name: 'node+lpac+job+noMemLimit', helperFlags: ['--no-job-mem-limit'], nodeArgs: [] },
        // Full LPAC+Job, JIT disabled -> if this PASSES, dynamic-code / ACG /
        // executable-memory allocation is the trigger.
        { name: 'node+lpac+job+jitless', helperFlags: [], nodeArgs: ['--jitless'] },
        // Full LPAC+Job, Wasm trap handler disabled -> if this PASSES, the
        // Wasm trap-handler registration is the trigger.
        { name: 'node+lpac+job+noWasmTrapHandler', helperFlags: [], nodeArgs: ['--disable-wasm-trap-handler'] },
      ];

      // Run each arm sequentially (an AppContainer Job name must be unique per
      // arm so a lingering Job from a prior arm cannot collide).
      const results: { name: string; code: number | null; passed: boolean; crashed: boolean }[] = [];
      for (let idx = 0; idx < arms.length; idx++) {
        const arm = arms[idx];
        const r = await runHelperStreaming([
          'run',
          ...arm.helperFlags,
          '--job', `OctJob-matrix-${idx}`,
          '--mem-mb', '256',
          '--pkg', pkg,
          '--proxy', '127.0.0.1:1',
          '--ca', ca,
          '--bootstrap', bootstrap,
          '--node', node,
          '--',
          ...arm.nodeArgs,
          '-e', CHILD_SCRIPT,
        ]);
        const crashed = isFastFail(r.code);
        const passed = r.code === 3 && r.stdout.includes('hi');
        results.push({ name: arm.name, code: r.code, passed, crashed });

        // The single greppable per-arm result line. PASS == node ran to
        // completion under this config (exit 3 + 'hi'); CRASH == the 0x80000003
        // fast-fail; anything else is an unexpected exit reported verbatim.
        const outcome = crashed
          ? `CRASH 0x80000003 (code=${r.code})`
          : passed
            ? `exit 3 (PASS — node ran under this config)`
            : `UNEXPECTED exit ${r.code} signal=${r.signal} stdout=<<<${r.stdout}>>>`;
        console.error(`[MATRIX] arm=${arm.name} -> ${outcome}`);
      }

      // Human-readable decision summary: the arms that PASSED are the layers
      // whose removal/flag made node viable. This is the data the next step
      // (adopt a flag vs recommend Option 3) is decided on.
      const passing = results.filter((x) => x.passed).map((x) => x.name);
      const crashing = results.filter((x) => x.crashed).map((x) => x.name);
      console.error('[MATRIX] summary:');
      console.error('[MATRIX]   PASS arms   =', passing.length ? passing.join(', ') : '(none)');
      console.error('[MATRIX]   CRASH arms  =', crashing.length ? crashing.join(', ') : '(none)');
      console.error('[MATRIX]   (see windows-run6-matrix-report.md for the outcome -> root-cause table)');

      // LANE-HONESTY: assert only that the matrix RAN — every arm produced a
      // definite exit result (code !== null, code !== -1 spawn error). We do
      // NOT assert the unfixed baseline crash, so the lane stays green purely
      // to harvest the matrix. TODO(run-6): restore the hard baseline
      // assertion (exit 3 + 'hi') once a remedy is adopted.
      expect(results.length).toBe(arms.length);
      for (const x of results) {
        expect(x.code, `arm ${x.name} produced no exit result`).not.toBeNull();
        expect(x.code, `arm ${x.name} failed to spawn`).not.toBe(-1);
      }
    } finally {
      rmSync(stage, { recursive: true, force: true });
    }
    // Generous timeout: 6 sequential arms, each a full LPAC process launch on a
    // CI runner. 180s bounds the worst case while a hang still streams live
    // "[run] <stage>" markers before failing.
  }, 180_000);
});

// ---------------------------------------------------------------------------
// OPTION-3 PRODUCTION REGRESSION — the TODO(run-6) restoration (Task 39).
//
// The matrix above stayed diagnostic-only ("assert only that the matrix ran")
// while the node launch crash was undiagnosed. Option 3 — restricted token +
// Job Object, no LPAC — is the adopted remedy and the PRODUCTION launch mode
// (`--restricted-token`; see job.ts / win-backend.ts). These tests restore
// the HARD fail-closed assertions the run-6 relaxation replaced: they launch
// node under the exact production configuration and assert the behavior that
// was unassertable while node crashed under LPAC.
//
// Restricted-token contract asserted here (helper.c Step A' / Task 36):
// CreateRestrictedToken with DISABLE_MAX_PRIVILEGE (only
// SeChangeNotifyPrivilege survives), local Administrators deny-only, Low
// integrity (S-1-16-4096), plus the unchanged Job Object carrying the
// JOB_OBJECT_LIMIT_JOB_MEMORY commit cap (--mem-mb).
//
// NO grant-acl in these tests: the restricted token derives from the
// helper's own user token, so the child reads the staged bootstrap/CA and
// the node dir via normal DACLs. grant-acl is an AppContainer concept; the
// production path has no ACL-grant step (Task 38), and pre-granting here
// would mask a real readability finding. If the child cannot read something
// on the lane, that surfaces loudly — exactly the point.
//
// Same lane contract as the matrix: itWin-gated (skips cleanly off-Windows
// or before the helper exe is built), NEVER skips on the Windows lane.
describe('helper run (Option 3: restricted-token + Job, production regression)', () => {
  itWin('runs node under restricted-token + Job (Option 3 production)', async () => {
    // THE core Option-3 regression: the production launch shape — node under
    // the CreateRestrictedToken-hardened token + the Job Object — must run
    // the child to completion. This is the assertion that was impossible
    // under LPAC and proves the adopted remedy.
    const node = process.execPath;
    const stage = mkdtempSync(path.join(tmpdir(), 'oct-helper-rt1-'));
    try {
      const bootstrap = path.join(stage, 'bootstrap.cjs');
      const ca = path.join(stage, 'ca.pem');
      writeFileSync(bootstrap, '// empty bootstrap for Option-3 core regression\n');
      writeFileSync(ca, '');
      // Run-11: launch from a session-private copy, not the toolchain path.
      const nodeCopy = stageNodeCopy(node, stage);

      const r = await runHelperStreaming([
        'run',
        '--restricted-token',
        '--global-job',
        '--job', 'OctJob-rt1',
        '--mem-mb', '512',
        '--pkg', 'AgentOctopus.Sandbox.rt1',
        '--proxy', '127.0.0.1:1',
        '--ca', ca,
        '--bootstrap', bootstrap,
        '--node', nodeCopy,
        '--',
        '-e', "process.stdout.write('hi');process.exit(3)",
      ]);

      // Guard that the production path was actually selected: cmd_run emits
      // this marker only when --restricted-token is set.
      expect(r.stderr, 'helper did not report the Option-3 production mode')
        .toContain('[run] mode: restricted-token (Option 3, production)');
      // HARD: node ran to completion under the restricted token + Job.
      expect(r.code,
        `expected child exit 3, got code=${r.code} signal=${r.signal} stderr=<<<${r.stderr}>>>`)
        .toBe(3);
      expect(r.stdout, 'child stdout is missing hi').toContain('hi');
    } finally {
      rmSync(stage, { recursive: true, force: true });
    }
  }, 60_000);

  itWin('restricted token is actually hardened (privileges stripped, low integrity)', async () => {
    // Restricted-token EFFECTIVENESS (Task 36 Step A'): the child env block
    // inherits PATH and the restricted token flows to grandchildren, so the
    // sandboxed node can spawn whoami and observe ITS OWN token. HARD
    // asserts: Low integrity present, and the dangerous privileges are GONE
    // (DISABLE_MAX_PRIVILEGE keeps only SeChangeNotifyPrivilege). The
    // presence of SeChangeNotifyPrivilege is deliberately NOT hard-asserted
    // (kept by design; its presence is not a failure mode).
    const node = process.execPath;
    const stage = mkdtempSync(path.join(tmpdir(), 'oct-helper-rt2-'));
    try {
      const bootstrap = path.join(stage, 'bootstrap.cjs');
      const ca = path.join(stage, 'ca.pem');
      writeFileSync(bootstrap, '// empty bootstrap for Option-3 hardening test\n');
      writeFileSync(ca, '');
      // Run-11: launch from a session-private copy, not the toolchain path.
      const nodeCopy = stageNodeCopy(node, stage);

      const script =
        "const{execFileSync}=require('child_process');" +
        "const g=execFileSync('whoami',['/groups']).toString();" +
        "const p=execFileSync('whoami',['/priv']).toString();" +
        "process.stdout.write('GROUPS:'+g+'PRIVS:'+p)";

      const r = await runHelperStreaming([
        'run',
        '--restricted-token',
        '--global-job',
        '--job', 'OctJob-rt2',
        '--mem-mb', '512',
        '--pkg', 'AgentOctopus.Sandbox.rt2',
        '--proxy', '127.0.0.1:1',
        '--ca', ca,
        '--bootstrap', bootstrap,
        '--node', nodeCopy,
        '--',
        '-e', script,
      ]);

      // HARD: node AND whoami ran to completion inside the sandbox. If
      // whoami cannot run under the restricted token this fails loudly —
      // correct: that is a real finding (Task 41), not something to skip.
      expect(r.code,
        `expected exit 0, got code=${r.code} signal=${r.signal} stderr=<<<${r.stderr}>>>`)
        .toBe(0);
      expect(r.stdout).toContain('GROUPS:');
      expect(r.stdout).toContain('PRIVS:');

      // Low integrity: whoami /groups prints "Mandatory Label\Low Mandatory
      // Level" with SID S-1-16-4096. Accept either rendering.
      const lowIntegrity = /Low Mandatory Level/i.test(r.stdout) || r.stdout.includes('S-1-16-4096');
      expect(lowIntegrity,
        `no Low integrity label in whoami output: <<<${r.stdout}>>>`).toBe(true);

      // Privilege strip: none of the dangerous privileges may be present in
      // the token whoami reports.
      expect(r.stdout).not.toContain('SeDebugPrivilege');
      expect(r.stdout).not.toContain('SeBackupPrivilege');
      expect(r.stdout).not.toContain('SeRestorePrivilege');
    } finally {
      rmSync(stage, { recursive: true, force: true });
    }
    // Generous timeout: two whoami spawns inside the sandboxed child on a CI
    // runner.
  }, 60_000);

  itWin('Job memory limit blocks an oversized allocation', async () => {
    // Job-limit EFFECTIVENESS: the Job carries JOB_OBJECT_LIMIT_JOB_MEMORY =
    // --mem-mb (256MB here) — a cap on the total COMMITTED memory of every
    // process in the Job. A 1GB zero-filling Buffer.alloc must therefore
    // FAIL its commit and the child must report ALLOC_BLOCKED. If the lane
    // shows ALLOC_OK the commit cap is not biting — a real finding; this
    // assertion is deliberately not weakened to hide it.
    const node = process.execPath;
    const stage = mkdtempSync(path.join(tmpdir(), 'oct-helper-rt3-'));
    try {
      const bootstrap = path.join(stage, 'bootstrap.cjs');
      const ca = path.join(stage, 'ca.pem');
      writeFileSync(bootstrap, '// empty bootstrap for Option-3 job-limit test\n');
      writeFileSync(ca, '');
      // Run-11: launch from a session-private copy, not the toolchain path.
      const nodeCopy = stageNodeCopy(node, stage);

      const r = await runHelperStreaming([
        'run',
        '--restricted-token',
        '--global-job',
        '--job', 'OctJob-rt3',
        '--mem-mb', '256',
        '--pkg', 'AgentOctopus.Sandbox.rt3',
        '--proxy', '127.0.0.1:1',
        '--ca', ca,
        '--bootstrap', bootstrap,
        '--node', nodeCopy,
        '--',
        '-e',
        "try{const b=Buffer.alloc(1024*1024*1024);process.stdout.write('ALLOC_OK');" +
        "}catch(e){process.stdout.write('ALLOC_BLOCKED');}",
      ]);

      // HARD: the child ran to completion AND the Job commit cap prevented
      // the oversized allocation.
      expect(r.code,
        `expected exit 0, got code=${r.code} signal=${r.signal} stderr=<<<${r.stderr}>>>`)
        .toBe(0);
      expect(r.stdout).not.toContain('ALLOC_OK');
      expect(r.stdout).toContain('ALLOC_BLOCKED');
    } finally {
      rmSync(stage, { recursive: true, force: true });
    }
  }, 60_000);
});

// Run-8/run-9 left the Option-3 launch failing hr=0x80070005 (ACCESS_DENIED)
// from CreateProcessWithTokenW for BOTH logon flags, after the restricted
// token built cleanly. This block runs helper.c's `diag-launch` battery,
// which decomposes that denial in a single CI run: impersonated access probes
// (image read+exec, winsta0, desktop) plus six launch variants (plain
// duplicate / production form ± CREATE_NO_WINDOW / WITH_PROFILE / no-Low /
// no-admins-deny). It is DIAGNOSTIC: it asserts only that the battery ran to
// completion, then logs every per-variant outcome to the CI log — the data
// that picks the fix. It NEVER skips on the lane (itWin contract), and a
// failing launch arm is data, not a test failure.
describe('helper run (run-10 restricted-token launch diagnostic battery)', () => {
  itWin('runs the diag-launch battery and logs every variant outcome', async () => {
    const node = process.execPath;
    // RUN-13: stage a node.exe COPY for the battery. The production freeze
    // happens against the session-private COPY (which the Low token can open);
    // the toolchain node.exe is unopenable by the Low token (path-based
    // denial), so a runtime resume-probe against it would only reproduce the
    // create-time err=5, not the runtime freeze. The label battery still
    // stages its own internal copy, so passing the copy here keeps both the
    // create-arms AND the new resume-arms on a Low-openable target.
    const stage = mkdtempSync(path.join(tmpdir(), 'oct-diag-'));
    try {
      const nodeCopy = stageNodeCopy(node, stage);
      const r = await runHelperStreaming(['diag-launch', '--node', nodeCopy]);

      // Structural: the helper accepted the args and the battery ran to
      // completion. Launch-arm failures are printed results, not exit failures.
      expect(r.code,
        `diag-launch did not complete: code=${r.code} signal=${r.signal} stderr=<<<${r.stderr}>>>`)
        .toBe(0);
      expect(r.stderr, 'battery start marker missing').toContain('[diag] battery start');
      expect(r.stderr, 'battery did not run to completion').toContain('[diag] battery complete');
      // RUN-13: the resume-based runtime matrix must have run (it is what can
      // see the Low-token runtime freeze the create-only arms are blind to).
      expect(r.stderr, 'runtime battery start marker missing')
        .toContain('[diag] runtime battery start');
      expect(r.stderr, 'runtime battery did not complete')
        .toContain('[diag] runtime battery complete');

      // Full record to the CI log, greppable by "[diag]".
      console.error('[diag-launch] battery output:\n' + r.stderr);
    } finally {
      rmSync(stage, { recursive: true, force: true });
    }
  }, 60_000);
});
