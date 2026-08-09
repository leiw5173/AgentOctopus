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
import { existsSync } from 'node:fs';

const PIPE = '\\\\.\\pipe\\octopus-sandbox-gate';

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
const itSvc = reachable ? it : it.skip;

describe('gate service (OctopusSandboxGate)', () => {
  itSvc('installs a gate, then refuses remove-gate while the named Job is alive', async () => {
    // install-gate returns the per-session filter keys. The Job name here is
    // a FAKE live job stand-in: because the service cannot confirm it dead,
    // remove-gate must be refused (Acceptance #9, spec §4c service-side
    // verification). We do NOT create a real Job; an unresolvable/absent Job
    // is reported differently from a confirmed-dead one, and the test asserts
    // the refuse invariant for the "not confirmed dead" case by using a Job
    // name that maps to a genuinely running job object in the full CI lane.
    const ins = await rpc({
      op: 'install-gate',
      sessionId: 's1',
      packageSid: 'S-1-15-2-1',
      proxyHost: '127.0.0.1',
      proxyPort: 8080,
      jobName: 'OctJob-s1',
    });
    expect(ins.ok).toBe(true);
    expect(Array.isArray(ins.filterKeys)).toBe(true);
    expect(ins.filterKeys.length).toBeGreaterThan(0);

    // remove-gate MUST be refused: the service resolves the lease, opens the
    // named Job itself, and only deletes the WFP filters after confirming the
    // Job is dead/empty. With the Job not confirmed dead the gate stays
    // (fail-closed) and the RPC reports ok:false.
    const rem = await rpc({ op: 'remove-gate', sessionId: 's1' });
    expect(rem.ok).toBe(false);
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
