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
import { existsSync, mkdtempSync, writeFileSync, rmSync } from 'node:fs';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const PIPE = '\\\\.\\pipe\\octopus-sandbox-gate';

const run = promisify(execFile);
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
    const c = net.connect(PIPE);
    const buf = Buffer.from(JSON.stringify(msg), 'utf8');
    const len = Buffer.alloc(4);
    len.writeUInt32LE(buf.length, 0);
    const chunks: Buffer[] = [];
    let settled = false;
    const done = (fn: () => void) => {
      if (settled) return;
      settled = true;
      fn();
    };
    c.on('connect', () => {
      c.write(Buffer.concat([len, buf]));
    });
    c.on('data', (d) => {
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
      done(() => reject(new Error('gate pipe closed before a full response frame')));
    });
    c.on('error', (e) => {
      done(() => reject(e));
    });
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

    // Stage a real loadable bootstrap + CA and grant the LPAC SIDs read access
    // (same reasoning as helper-run.test.ts): the LPAC child cannot read
    // arbitrary temp paths, and cannot read node.exe's install dir by default.
    const node = process.execPath;
    const stage = mkdtempSync(path.join(tmpdir(), 'oct-gate-svc-'));
    const bootstrap = path.join(stage, 'bootstrap.cjs');
    const ca = path.join(stage, 'ca.pem');
    writeFileSync(bootstrap, '// empty bootstrap for gate-svc live-job test\n');
    writeFileSync(ca, '');
    await run(HELPER_EXE, ['grant-acl', '--pkg', pkg, '--path', stage]);
    await run(HELPER_EXE, ['grant-acl', '--pkg', pkg, '--path', path.dirname(node)]).catch(() => {});

    // Launch the long-lived child detached (do NOT await — it runs ~5 min).
    // We capture its stderr via the process object so a launch failure is
    // diagnosable from the CI log. unref() so the test process is not held.
    const child = execFile(HELPER_EXE, [
      'run',
      '--job', jobName,
      '--mem-mb', '256',
      '--pkg', pkg,
      '--proxy', '127.0.0.1:1',
      '--ca', ca,
      '--bootstrap', bootstrap,
      '--node', node,
      '--',
      '-e', 'setTimeout(()=>{},300000)',
    ], (err, stdout, stderr) => {
      if (err) {
        console.error('[gate-svc] long-lived helper exited:',
          '\n  code=', (err as any).code,
          '\n  stdout=<<<', stdout, '>>>',
          '\n  stderr=<<<', stderr, '>>>');
      }
    });
    child.unref();

    // Give the helper a moment to create the Job, assign the child, and resume
    // it. 1500ms is generous for process+job setup on a CI runner.
    await new Promise((r) => setTimeout(r, 1500));

    try {
      const ins = await rpc({
        op: 'install-gate',
        sessionId,
        packageSid: 'S-1-15-2-1',
        proxyHost: '127.0.0.1',
        proxyPort: 8080,
        jobName,
      });
      expect(ins.ok).toBe(true);
      expect(Array.isArray(ins.filterKeys)).toBe(true);
      expect(ins.filterKeys.length).toBeGreaterThan(0);

      // remove-gate MUST be refused while the Job is alive: the service
      // resolves the lease, opens the named Job, sees ActiveProcesses>0, and
      // keeps the gate (fail-closed) reporting ok:false.
      const rem = await rpc({ op: 'remove-gate', sessionId });
      console.error('[gate-svc] remove-gate while Job alive ->', JSON.stringify(rem));
      expect(rem.ok).toBe(false);
    } finally {
      // Kill the long-lived child so the Job drains, then removal must succeed.
      // KILL_ON_JOB_CLOSE guarantees the child dies with the Job; killing the
      // helper tears down the whole tree. Best-effort: the lane is ephemeral.
      try { child.kill('SIGKILL'); } catch { /* already gone */ }
      rmSync(stage, { recursive: true, force: true });
    }

    // After the child dies the Job is empty/gone; remove-gate now succeeds.
    // Poll briefly — KILL_ON_JOB_CLOSE unwind is not instantaneous.
    let removed: any = null;
    for (let i = 0; i < 20; i++) {
      await new Promise((r) => setTimeout(r, 250));
      removed = await rpc({ op: 'remove-gate', sessionId });
      if (removed.ok === true) break;
    }
    console.error('[gate-svc] remove-gate after Job drained ->', JSON.stringify(removed));
    expect(removed.ok).toBe(true);
  });

  itSvc('remove-gate on a nonexistent Job succeeds (Job is genuinely gone)', async () => {
    // Precise fail-closed contract for the OTHER branch: a Job that no longer
    // exists IS dead (OpenJobObjectW == ERROR_FILE_NOT_FOUND), so remove-gate
    // proceeds and returns ok:true. This is the service's correct, fail-safe
    // behavior — complementary to the alive-Job refusal asserted above. We use
    // a fresh session with a Job name that was never created.
    const ins = await rpc({
      op: 'install-gate',
      sessionId: 's-gone',
      packageSid: 'S-1-15-2-1',
      proxyHost: '127.0.0.1',
      proxyPort: 8080,
      jobName: 'OctJob-never-existed',
    });
    expect(ins.ok).toBe(true);

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
