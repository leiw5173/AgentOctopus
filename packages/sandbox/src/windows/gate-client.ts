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
 *   install-gate { op, sessionId, appIdPath, proxyHost, proxyPort, jobName,
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
  /**
   * DOS path of the sandbox node.exe the WFP `FWPM_CONDITION_ALE_APP_ID`
   * condition keys on (Option 3: the restricted-token child is scoped by its
   * image path, not an AppContainer package). The service canonicalizes it via
   * `FwpmGetAppIdFromFileName0`, which requires a real, existing node.exe DOS
   * path on the host — a throwaway/nonexistent path makes the service reject
   * install-gate (fail-closed). Send the plain DOS form (`C:\...\node.exe`),
   * never an NT device path or a `\\?\`-prefixed extended path.
   */
  appIdPath: string;
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

/**
 * Transient connect-retry policy. The gate service is a single-instance
 * named-pipe server: between two clients there is a brief window where no
 * pipe instance exists (disconnect → next CreateNamedPipe), and a concurrent
 * client that hits it gets ENOENT even though the service is up and about
 * to listen again. Retry ONLY connect-time failures (never after the request
 * frame was written — a post-write retry could double-deliver install-gate),
 * bounded and short. A genuinely absent service still exhausts the retries
 * and fails closed exactly as before.
 */
const CONNECT_RETRY_CODES = new Set(['ENOENT', 'EACCES', 'EBUSY', 'EAGAIN']);
const MAX_CONNECT_ATTEMPTS = 4;
const CONNECT_RETRY_DELAY_MS = 150;

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
    const chunks: Buffer[] = [];
    let settled = false;
    let activeSocket: Socket | null = null;

    const timer = setTimeout(() => {
      fail(`gate service pipe ${pipePath} timed out after ${timeoutMs}ms`);
    }, timeoutMs);

    const fail = (msg: string) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      if (activeSocket) activeSocket.destroy();
      reject(new WindowsSandboxError(msg));
    };

    const attemptConnect = (attempt: number) => {
      if (settled) return;
      const socket = new Socket();
      activeSocket = socket;
      let connected = false;

      socket.on('error', (err: NodeJS.ErrnoException) => {
        if (socket !== activeSocket) return; /* superseded retry socket */
        /* Connect-time-only transient retry (see CONNECT_RETRY_CODES):
         * before `connected` no request frame was written, so a retry can
         * never double-deliver install-gate. */
        if (!connected && attempt < MAX_CONNECT_ATTEMPTS &&
            CONNECT_RETRY_CODES.has(err.code ?? '')) {
          socket.destroy();
          setTimeout(() => attemptConnect(attempt + 1), CONNECT_RETRY_DELAY_MS);
          return;
        }
        fail(`cannot reach gate service pipe ${pipePath}: ${err.message}`);
      });

      socket.on('data', (chunk: Buffer) => {
        if (socket !== activeSocket) return;
        chunks.push(chunk);
        const buf = Buffer.concat(chunks);
        if (buf.length < 4) return;
        const len = buf.readUInt32LE(0);
        if (len > MAX_RPC_BYTES) {
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
        if (socket !== activeSocket) return; /* superseded retry socket */
        if (!settled) {
          fail(`gate service pipe ${pipePath} closed before a full response frame arrived`);
        }
      });

      socket.connect(pipePath, () => {
        connected = true;
        socket.write(frame);
      });
    };

    attemptConnect(1);
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
  if (typeof req.appIdPath !== 'string' || req.appIdPath.length === 0) {
    throw new WindowsSandboxError('appIdPath must be a non-empty string');
  }
  const resp = await gateRpc(
    {
      op: 'install-gate',
      sessionId: req.sessionId,
      appIdPath: req.appIdPath,
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
