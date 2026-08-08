/**
 * Gate-service client — TS wrapper for the octopus-sandbox-gate-svc named
 * pipe.
 *
 * Wire protocol (gate-svc.c serve_one_client / handle_request): one request
 * per connection, framed as a 4-byte little-endian length prefix followed by
 * a UTF-8 JSON body; the service replies with the same framing and closes.
 * Pipe path: \\.\pipe\octopus-sandbox-gate.
 *
 * Ops:
 *   install-gate { op, sessionId, packageSid, proxyHost, proxyPort, jobName,
 *                  proxyV6Loopback }
 *     -> { ok:true, filterKeys:[...] }  |  { ok:false, error:"..." }
 *   remove-gate  { op, sessionId }
 *     -> { ok:true }                    |  { ok:false, error:"..." }
 *
 * PROXY-V6 PLUMBING (Task 9 deferral, resolved TS-side): gate-svc.c
 * install_gate takes a hasV6Loopback flag that decides whether the ::1
 * loopback permit (WFP rule 3) is added — the service must not guess. The
 * RPC therefore carries an explicit `proxyV6Loopback` boolean; when the
 * proxy dual-binds (listens on ::1 as well as 127.0.0.1) the TS side sends
 * proxyV6Loopback:true and the service adds the V6 permit. The request field
 * name is `proxyV6Loopback` and gate-svc.c's handle_request must parse that
 * exact key into its hasV6Loopback argument (in place of the hardcoded
 * FALSE passed for v4 hosts today).
 *
 * Fail-closed: any connect/read/write/parse failure, a {"ok":false}
 * response, or a missing pipe throws a WindowsSandboxError — no call ever
 * resolves on a failed backend round-trip.
 *
 * This module is leaf-package production code: Node stdlib only.
 */
import { Socket } from 'node:net';
import { WindowsSandboxError } from './errors.js';

export const DEFAULT_GATE_PIPE_PATH = '\\\\.\\pipe\\octopus-sandbox-gate';

export interface GateClientOptions {
  /** Override the named-pipe path (testing / non-default service). */
  pipePath?: string;
  /** Round-trip timeout in ms (default 10_000). */
  timeoutMs?: number;
}

export interface InstallGateRequest {
  sessionId: string;
  packageSid: string;
  /** Loopback proxy host the WFP permit targets: "127.0.0.1" or "::1". */
  proxyHost: string;
  proxyPort: number;
  jobName: string;
  /**
   * True when the egress proxy also listens on ::1 — the service then adds
   * the V6 loopback permit (WFP rule 3). Sent as the `proxyV6Loopback` JSON
   * field, which gate-svc.c parses into install_gate's hasV6Loopback.
   */
  proxyV6Loopback: boolean;
}

const MAX_RPC_BYTES = 64 * 1024;

interface GateResponse {
  ok?: unknown;
  filterKeys?: unknown;
  error?: unknown;
}

/**
 * One framed JSON round-trip against the gate service pipe. Resolves with
 * the parsed response body; throws WindowsSandboxError on any transport,
 * framing, or JSON failure.
 */
async function gateRpc(body: Record<string, unknown>, opts?: GateClientOptions): Promise<GateResponse> {
  const pipePath = opts?.pipePath ?? DEFAULT_GATE_PIPE_PATH;
  const timeoutMs = opts?.timeoutMs ?? 10_000;
  const payload = Buffer.from(JSON.stringify(body), 'utf8');
  if (payload.length > MAX_RPC_BYTES) {
    throw new WindowsSandboxError(`gate request too large: ${payload.length} bytes`);
  }
  const frame = Buffer.allocUnsafe(4 + payload.length);
  frame.writeUInt32LE(payload.length, 0);
  payload.copy(frame, 4);

  return new Promise<GateResponse>((resolve, reject) => {
    const socket = new Socket();
    const chunks: Buffer[] = [];
    let settled = false;

    const fail = (msg: string) => {
      if (settled) return;
      settled = true;
      socket.destroy();
      reject(new WindowsSandboxError(msg));
    };

    const timer = setTimeout(() => {
      fail(`gate service pipe ${pipePath} timed out after ${timeoutMs}ms`);
    }, timeoutMs);

    socket.on('error', (err) => {
      clearTimeout(timer);
      fail(`cannot reach gate service pipe ${pipePath}: ${err.message}`);
    });

    socket.on('data', (chunk: Buffer) => {
      chunks.push(chunk);
      const buf = Buffer.concat(chunks);
      if (buf.length < 4) return;
      const len = buf.readUInt32LE(0);
      if (len > MAX_RPC_BYTES) {
        clearTimeout(timer);
        fail(`gate service response too large: ${len} bytes`);
        return;
      }
      if (buf.length < 4 + len) return;
      clearTimeout(timer);
      const text = buf.subarray(4, 4 + len).toString('utf8');
      socket.end();
      let parsed: GateResponse;
      try {
        parsed = JSON.parse(text) as GateResponse;
      } catch {
        fail(`gate service returned invalid JSON: ${JSON.stringify(text)}`);
        return;
      }
      if (settled) return;
      settled = true;
      resolve(parsed);
    });

    socket.on('close', () => {
      if (!settled) {
        clearTimeout(timer);
        fail(`gate service pipe ${pipePath} closed before a full response frame arrived`);
      }
    });

    socket.connect(pipePath, () => {
      socket.write(frame);
    });
  });
}

/**
 * Install the WFP loopback gate for a sandbox session. Resolves with the
 * service-assigned filter keys; throws WindowsSandboxError on any transport
 * failure or an {"ok":false} response.
 */
export async function installGate(
  req: InstallGateRequest,
  opts?: GateClientOptions,
): Promise<{ filterKeys: string[] }> {
  const resp = await gateRpc(
    {
      op: 'install-gate',
      sessionId: req.sessionId,
      packageSid: req.packageSid,
      proxyHost: req.proxyHost,
      proxyPort: req.proxyPort,
      jobName: req.jobName,
      proxyV6Loopback: req.proxyV6Loopback,
    },
    opts,
  );
  if (resp.ok !== true) {
    throw new WindowsSandboxError(
      `install-gate refused by service: ${typeof resp.error === 'string' ? resp.error : JSON.stringify(resp)}`,
    );
  }
  if (!Array.isArray(resp.filterKeys) || resp.filterKeys.some((k) => typeof k !== 'string')) {
    throw new WindowsSandboxError('install-gate response missing filterKeys string array');
  }
  return { filterKeys: resp.filterKeys as string[] };
}

/**
 * Remove the WFP loopback gate for a sandbox session. Throws
 * WindowsSandboxError on any transport failure or an {"ok":false} response.
 */
export async function removeGate(sessionId: string, opts?: GateClientOptions): Promise<void> {
  if (typeof sessionId !== 'string' || sessionId.length === 0) {
    throw new WindowsSandboxError('sessionId must be a non-empty string');
  }
  const resp = await gateRpc({ op: 'remove-gate', sessionId }, opts);
  if (resp.ok !== true) {
    throw new WindowsSandboxError(
      `remove-gate refused by service: ${typeof resp.error === 'string' ? resp.error : JSON.stringify(resp)}`,
    );
  }
}
