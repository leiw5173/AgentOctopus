// packages/sandbox/tests/windows/gate-svc.test.ts
//
// Drives the INSTALLED+RUNNING companion service `OctopusSandboxGate`
// (octopus-sandbox-gate-svc.exe, Task 9 C source at
// src/windows/service/gate-svc.c). The service owns the persistent WFP
// egress allowlist for the Windows sandbox backend (spec §4c) and exposes
// exactly two RPC operations over a strictly-ACL'd named pipe.
//
// Wire protocol (shared with the C service): each message is a 4-byte
// little-endian length prefix followed by a UTF-8 JSON body. The service
// reads one request per connection and replies with a single framed JSON
// response, then closes.
//
// On any non-Windows host every test in this file SKIPS cleanly — it must
// never fail, crash, or block waiting on a pipe that does not exist. On
// Windows it additionally requires the service to be installed and running
// (a one-time elevated step); when the pipe is absent the tests skip too.
import { describe, it, expect } from 'vitest';
import net from 'node:net';
import { existsSync, mkdtempSync, writeFileSync, rmSync, copyFileSync } from 'node:fs';
import { spawn } from 'node:child_process';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const PIPE = '\\\\.\\pipe\\octopus-sandbox-gate';

const HERE = path.dirname(fileURLToPath(import.meta.url));
const HELPER_EXE = path.join(HERE, '..', '..', 'prebuilds', 'windows-x64', 'octopus-sandbox-helper.exe');

// On Windows a named pipe is not a filesystem object, so existsSync() is not
// a reliable probe. We treat "can we connect" as the availability signal and
// only attempt the real RPC assertions when a probe connection succeeds. Off
// Windows we skip unconditionally.
const isWin = process.platform === 'win32';

// One framed round-trip matching the service wire protocol exactly (and the
// production gate-client.ts): write a 4-byte LE length prefix + JSON body,
// then read the response as length-prefix + exactly N body bytes. We resolve
// on the COMPLETE frame — we do NOT wait for the server to close the pipe.
// Resolving on 'end' (the previous behavior) raced the server's close: on a
// named pipe the server's post-response DisconnectNamedPipe can surface to
// the client as a hard error (EPIPE/ECONNRESET, errno -4047) instead of a
// clean 'end', so a wait-for-'end' client intermittently fails even on a
// well-formed response. Reading the explicit length prefix is the correct,
// race-free framing.
const MAX_RPC_BYTES = 64 * 1024;

function rpc(msg: object): Promise<any> {
  return new Promise((resolve, reject) => {
    const buf = Buffer.from(JSON.stringify(msg), 'utf8');
    const len = Buffer.alloc(4);
    len.writeUInt32LE(buf.length, 0);
    const chunks: Buffer[] = [];
    let settled = false;
    let active: net.Socket | null = null;
    const done = (fn: () => void) => {
      if (settled) return;
      settled = true;
      fn();
    };
    // The gate service is a single-instance named-pipe server: a concurrent
    // client (the win-backend probe runs in parallel on another vitest
    // worker) can hit the brief between-clients window where no pipe
    // instance exists and receive ENOENT although the service IS up. Retry
    // connect-time failures only (pre-connect: the request frame was never
    // written, so no double-deliver), bounded and short — mirrors the
    // production gate-client retry policy.
    const RETRY_CODES = new Set(['ENOENT', 'EACCES', 'EBUSY', 'EAGAIN']);
    const attempt = (n: number) => {
      if (settled) return;
      const c = net.connect(PIPE);
      active = c;
      let connected = false;
      c.on('connect', () => {
        connected = true;
        c.write(Buffer.concat([len, buf]));
      });
      c.on('data', (d) => {
        if (c !== active) return;
        chunks.push(d);
        const acc = Buffer.concat(chunks);
        if (acc.length < 4) return;
        const bodyLen = acc.readUInt32LE(0);
        if (bodyLen > MAX_RPC_BYTES) {
          done(() => reject(new Error(`oversized response frame: ${bodyLen}`)));
          return;
        }
        if (acc.length < 4 + bodyLen) return;
        const body = acc.subarray(4, 4 + bodyLen);
        done(() => {
          try {
            resolve(JSON.parse(body.toString('utf8')));
          } catch (e) {
            reject(e);
          }
        });
      });
      // If the server closes (or errors) before a full frame arrived, that is a
      // transport failure — reject so the caller can assert on it. After a full
      // frame we are already settled, so a late close/error is ignored.
      c.on('end', () => {
        if (c !== active) return; /* superseded retry socket */
        done(() => reject(new Error('gate pipe closed before a full response frame')));
      });
      c.on('error', (e: NodeJS.ErrnoException) => {
        if (c !== active) return; /* superseded retry socket */
        if (!connected && n < 4 && RETRY_CODES.has(e.code ?? '')) {
          c.destroy();
          setTimeout(() => attempt(n + 1), 150);
          return;
        }
        done(() => reject(e));
      });
    };
    attempt(1);
  });
}

// Resolve once whether the service pipe answers. A refused/absent connection
// means the service is not installed/running on this host -> skip.
async function serviceReachable(): Promise<boolean> {
  if (!isWin) return false;
  return new Promise((resolve) => {
    const c = net.connect(PIPE);
    c.on('connect', () => {
      c.destroy();
      resolve(true);
    });
    c.on('error', () => resolve(false));
    // A hung connect should not stall the runner.
    setTimeout(() => {
      c.destroy();
      resolve(false);
    }, 1500);
  });
}

const reachable = await serviceReachable();
// The live-Job remove-gate test additionally needs the built helper exe to
// create + populate a real named Job. Off Windows (or before the helper is
// built) every test in this file skips — it must never fail or block.
const helperReady = isWin && existsSync(HELPER_EXE);
const itSvc = reachable ? it : it.skip;
const itSvcLiveJob = (reachable && helperReady) ? it : it.skip;

describe('gate service (OctopusSandboxGate)', () => {
  itSvcLiveJob('installs a gate, then refuses remove-gate while the named Job is alive', async () => {
    // Acceptance #9 (spec §4c) is the fail-closed invariant: the service must
    // NOT remove a session's WFP filters while that session's Job is alive.
    //
    // The service's job_confirmed_dead() correctly treats OpenJobObjectW ==
    // ERROR_FILE_NOT_FOUND as DEAD (a Job that no longer exists IS gone). So a
    // FAKE job name exercises the "Job already gone" path (remove-gate ->
    // ok:true), NOT the "Job alive" path this test claims. The run-1 version
    // passed jobName 'OctJob-s1' without ever creating a real Job and asserted
    // ok:false — which was wrong: the service (correctly, fail-safe) saw the
    // Job as gone and removed the gate. Service behavior is correct; the test
    // premise was not.
    //
    // To genuinely test the alive invariant we must create a REAL, live, named
    // Job. Node cannot call CreateJobObjectW, but the helper.exe CAN: `run`
    // creates the named Job and assigns the child to it. Launch a LONG-LIVED
    // child under `--job OctJob-s1`; while that child runs, the service opens
    // OctJob-s1 and sees ActiveProcesses>0, so remove-gate MUST be refused
    // (ok:false). Afterwards we kill the child so the Job drains and the gate
    // can be removed (cleanup), and assert removal then succeeds (ok:true).
    const sessionId = 's1';
    const jobName = 'OctJob-s1';
    const pkg = 'AgentOctopus.Sandbox.gate1';

    // Stage a real loadable bootstrap + CA. OPTION 3: the long-lived child
    // below runs under the PRODUCTION restricted-token + Job mode, so there
    // is NO grant-acl step here — the restricted token derives from the
    // helper's own user token and reads the staged copy + node dir via
    // normal DACLs. grant-acl is an AppContainer concept; Task 38 removed it
    // from the production win-backend path, and this fixture must not
    // reintroduce it (pre-granting would mask a real readability finding).
    const node = process.execPath;
    const stage = mkdtempSync(path.join(tmpdir(), 'oct-gate-svc-'));
    const bootstrap = path.join(stage, 'bootstrap.cjs');
    const ca = path.join(stage, 'ca.pem');
    writeFileSync(bootstrap, '// empty bootstrap for gate-svc live-job test\n');
    writeFileSync(ca, '');
    // Run-11: the Low-integrity token cannot open the toolchain node.exe
    // (CI 31359902308), so launch from a session-private copy — and key the
    // WFP gate's APP_ID on that same copy (the image the child executes).
    const nodeCopy = path.join(stage, 'node.exe');
    copyFileSync(node, nodeCopy);

    // Launch the long-lived child with spawn() so its stdout/stderr STREAM live
    // into the test as chunks arrive (execFile's callback only fires on child
    // exit, so a helper that hangs during run setup showed nothing — that is
    // exactly what masked this test's 5s timeout in run 31319124171). We mirror
    // each chunk to console.error immediately so the CI log shows the last
    // "[run] <stage>" marker reached — telling us whether the Job was created
    // ("[run] child assigned to job" / "[run] child resumed") or the helper
    // hung earlier. unref() so the test process is not held.
    const child = spawn(HELPER_EXE, [
      'run',
      // OPTION 3 PRODUCTION MODE: the long-lived child runs under the
      // restricted token + Job (no LPAC), which is how win-backend launches
      // node — and under which node is expected to SURVIVE.
      '--restricted-token',
      '--job', jobName,
      '--mem-mb', '256',
      '--pkg', pkg,
      '--proxy', '127.0.0.1:1',
      '--ca', ca,
      '--bootstrap', bootstrap,
      '--node', nodeCopy,
      '--',
      '-e', 'setTimeout(()=>{},300000)',
    ], { stdio: ['ignore', 'pipe', 'pipe'] });
    let childStdout = '';
    let childStderr = '';
    const exitRef: { current: { code: number | null; signal: string | null } | null } = { current: null };
    child.stdout.on('data', (d: Buffer) => {
      const s = d.toString('utf8');
      childStdout += s;
      process.stderr.write(`[gate-svc helper stdout] ${s}`);
    });
    child.stderr.on('data', (d: Buffer) => {
      const s = d.toString('utf8');
      childStderr += s;
      process.stderr.write(`[gate-svc helper stderr] ${s}`);
    });
    child.on('error', (e) => {
      process.stderr.write(`[gate-svc helper spawn error] ${String(e)}\n`);
    });
    child.on('close', (code, signal) => {
      exitRef.current = { code, signal };
      // The child is launched for ~5 min; an early close means the helper
      // failed to launch/run the long-lived node. Surface its captured output
      // so the refusal assertion below can be interpreted (Job never created).
      console.error('[gate-svc] long-lived helper exited early:',
        '\n  code=', code, '\n  signal=', signal,
        '\n  stdout=<<<', childStdout, '>>>',
        '\n  stderr=<<<', childStderr, '>>>');
    });
    child.unref();

    // Give the helper a moment to create the Job, assign the child, and resume
    // it. 1500ms is generous for process+job setup on a CI runner. Under
    // Option 3 an early exit here is UNEXPECTED (node is supposed to run
    // under the restricted token + Job); report it immediately so a failed
    // alive-refusal below is attributable to "Job never populated" rather
    // than "remove-gate allowed".
    await new Promise((r) => setTimeout(r, 1500));
    if (exitRef.current !== null) {
      console.error('[gate-svc] UNEXPECTED: helper exited before install-gate;',
        'OctJob-s1 may never have been populated. exit=', JSON.stringify(exitRef.current));
    }

    // OPTION-3 CONTRACT: the long-lived child runs under the restricted
    // token + Job (no LPAC), so it is EXPECTED to survive the settle window —
    // the LPAC-era launch crash does not apply to this path. Survival is what
    // makes the alive-Job refusal below genuinely assertable again (it was
    // degraded to a run-6 diagnostic while node crashed under LPAC). If the
    // child did NOT survive, that is an unexpected Option-3 failure — a
    // Task-41 finding — and this test fails loudly instead of routing around
    // it. The test never SKIPs (the lane's zero-skip gate).
    const childSurvived = exitRef.current === null;

    try {
      const ins = await rpc({
        op: 'install-gate',
        sessionId,
        // Option 3 + run-11: the gate is APP_ID-scoped on the sandbox node.exe
        // COPY — the image the child actually executes (the Low token cannot
        // open the toolchain path). The service canonicalizes via
        // FwpmGetAppIdFromFileName0, which requires the file to exist.
        appIdPath: nodeCopy,
        proxyHost: '127.0.0.1',
        proxyPort: 8080,
        jobName,
      });
      expect(ins.ok, `install-gate response: ${JSON.stringify(ins)}`).toBe(true);
      expect(Array.isArray(ins.filterKeys)).toBe(true);
      expect(ins.filterKeys.length).toBeGreaterThan(0);

      // remove-gate MUST be refused while the Job is alive: the service
      // resolves the lease, opens the named Job, sees ActiveProcesses>0, and
      // keeps the gate (fail-closed) reporting ok:false.
      const rem = await rpc({ op: 'remove-gate', sessionId });
      console.error('[gate-svc] remove-gate while Job alive ->', JSON.stringify(rem),
        '(childSurvived=', childSurvived, ')');
      if (childSurvived) {
        // Node ran: the Job is genuinely populated, so the fail-closed
        // refusal MUST hold. This is the hard assertion Option 3 restores.
        expect(rem.ok).toBe(false);
      } else {
        // UNEXPECTED under Option 3: node is expected to SURVIVE under the
        // restricted token + Job. In run-6 this branch was the known LPAC
        // crash state and merely logged; under the production mode it
        // indicates a genuine failure (the Job drained before this RPC,
        // making the refusal unassertable). Fail loudly for Task 41.
        throw new Error(
          '[gate-svc] long-lived node child did not survive under restricted-token + Job; ' +
          `alive-Job refusal not assertable. exit=${JSON.stringify(exitRef.current)} ` +
          `stdout=<<<${childStdout}>>> stderr=<<<${childStderr}>>>`);
      }
    } finally {
      // Kill the long-lived child so the Job drains, then removal must succeed.
      // KILL_ON_JOB_CLOSE guarantees the child dies with the Job; killing the
      // helper tears down the whole tree. Best-effort: the lane is ephemeral.
      try { child.kill('SIGKILL'); } catch { /* already gone */ }
      rmSync(stage, { recursive: true, force: true });
    }

    // After the child dies the Job is empty/gone; remove-gate now succeeds.
    // Poll briefly — KILL_ON_JOB_CLOSE unwind is not instantaneous.
    //
    // Reachable only when the alive-refusal above held: the else branch
    // throws, so the crash-path caveat from run-6 (first remove-gate already
    // dropped the lease) no longer needs a branch. This asserts the
    // complement of the fail-closed invariant: once the Job has drained, the
    // gate IS removed (ok:true).
    let removed: any = null;
    for (let i = 0; i < 20; i++) {
      await new Promise((r) => setTimeout(r, 250));
      removed = await rpc({ op: 'remove-gate', sessionId });
      if (removed.ok === true) break;
    }
    console.error('[gate-svc] remove-gate after Job drained ->', JSON.stringify(removed));
    expect(removed.ok).toBe(true);
    // 60s timeout: the settle (1.5s) + drain poll (up to 5s) + RPC round-trips
    // must not false-timeout on a slow CI runner, and a hung helper streams its
    // stage markers live before the timeout fires.
  }, 60_000);

  itSvc('remove-gate on a nonexistent Job succeeds (Job is genuinely gone)', async () => {
    // Precise fail-closed contract for the OTHER branch: a Job that no longer
    // exists IS dead (OpenJobObjectW == ERROR_FILE_NOT_FOUND), so remove-gate
    // proceeds and returns ok:true. This is the service's correct, fail-safe
    // behavior — complementary to the alive-Job refusal asserted above. We use
    // a fresh session with a Job name that was never created.
    const ins = await rpc({
      op: 'install-gate',
      sessionId: 's-gone',
      // Option 3: APP_ID-scoped gate — pass a real existing node.exe DOS path.
      appIdPath: process.execPath,
      proxyHost: '127.0.0.1',
      proxyPort: 8080,
      jobName: 'OctJob-never-existed',
    });
    expect(ins.ok, `install-gate response: ${JSON.stringify(ins)}`).toBe(true);

    const rem = await rpc({ op: 'remove-gate', sessionId: 's-gone' });
    console.error('[gate-svc] remove-gate nonexistent Job ->', JSON.stringify(rem));
    expect(rem.ok).toBe(true);
  });

  itSvc('rejects a malformed / oversized frame without crashing', async () => {
    // An unknown op must be refused cleanly (ok:false), never a crash. This
    // guards the strict length-capped JSON handling. The service answers with
    // a well-formed {"ok":false,"error":"unknown-op"} frame and then closes;
    // the length-prefix framing in rpc() resolves on that complete frame
    // before the server's DisconnectNamedPipe can race the client into EPIPE.
    const bad = await rpc({ op: 'no-such-op', sessionId: 's1' });
    expect(bad.ok).toBe(false);
  });
});
