/**
 * Plan 4, Task 3 (Step 0) — interface-only stub for the named network
 * namespace handle the OS backend passes into the phased launcher.
 *
 * Task 4 extends THIS FILE with the implementations (`setupNetns`,
 * `authorizeProxyEndpoint`, `buildNetnsCommands`). The contract is declared
 * here so the Task 3 launch-spec builder + tests can compile against it.
 *
 * Leaf-package rule: Node stdlib only.
 */

import crypto from 'node:crypto';
import net from 'node:net';
import { execFile as execFileCb } from 'node:child_process';
import { promisify } from 'node:util';

export class NetnsError extends Error {
  constructor(message: string, options?: { cause?: unknown }) {
    super(message, options);
    this.name = 'NetnsError';
  }
}

export interface NetnsHandle {
  /** Kernel-visible namespace name (e.g. `octn-deadbeef`). */
  readonly name: string;
  /** Host path handed to setns() (e.g. `/run/netns/octn-deadbeef`). */
  readonly path: string;
  /** veth interface name on the host side. */
  readonly hostIf: string;
  /** veth interface name inside the skill namespace. */
  readonly skillIf: string;
  /** Link-local address the egress proxy listens on inside the namespace. */
  readonly proxyIp: string;
  /** Link-local address assigned to the skill side of the veth pair. */
  readonly skillIp: string;
  /** TCP port the egress proxy listens on inside the namespace. */
  readonly proxyPort: number;
  /** Per-session nftables table holding the allowlist rules. */
  readonly nftTable: string;
  /**
   * Errors recorded during cleanup that were NOT the benign "already-absent"
   * case. Already-absent own objects (ENOENT-style) are success and are NOT
   * recorded here; other teardown errors (EBUSY, still-in-use, permission)
   * ARE recorded so callers can surface leaks. Readonly snapshot — appended
   * by cleanup() but never cleared.
   */
  readonly cleanupErrors: ReadonlyArray<{ argv: string[]; error: string }>;
  /** Idempotent teardown of the namespace, veth pair, and nft table. */
  cleanup(): Promise<void>;
}

// ---------------------------------------------------------------------------
// DI seam — all kernel ops go through this. Production callers get the real
// execFile; tests inject an in-memory fake so ORDER + fail-closed can be
// exercised on macOS. The seam is never consulted for behavior, only for I/O.
// ---------------------------------------------------------------------------

export interface NetnsExec {
  /**
   * Run argv[0] with argv.slice(1) as arguments. If `stdin` is given, pipe it
   * into the process. Reject on non-zero exit. Never invoke a shell.
   */
  execFile(argv: string[], stdin?: string): Promise<{ stdout: string; stderr: string }>;
  /**
   * Allocate an ephemeral TCP port by binding to `ip:0`, reading the assigned
   * port, and closing. Defaults to a real `net.createServer()` bind.
   * Injectable so the fake-exec tests can run on macOS (no link-local addrs).
   */
  allocatePort?(ip: string): Promise<number>;
}

const realExecFileAsync = promisify(execFileCb);

const realNetnsExec: NetnsExec = {
  async execFile(argv, stdin) {
    const [file, ...args] = argv;
    if (stdin !== undefined) {
      // Spawn EXACTLY ONCE for stdin-bearing commands (nft -f -). execFile
      // would spawn its own child with no way to feed stdin, so we cannot
      // call it first — doing so would leak a hung child blocked reading
      // stdin forever. Import spawn lazily so the no-stdin fast path stays
      // sync-looking.
      const { spawn } = await import('node:child_process');
      return await new Promise((resolve, reject) => {
        const p = spawn(file, args, { stdio: ['pipe', 'pipe', 'pipe'] });
        let stdout = '';
        let stderr = '';
        p.stdout.on('data', (d) => { stdout += d.toString(); });
        p.stderr.on('data', (d) => { stderr += d.toString(); });
        p.on('error', reject);
        p.on('close', (code) => {
          if (code === 0) resolve({ stdout, stderr });
          else reject(new Error(`argv ${argv.join(' ')} exited ${code}: ${stderr.trim()}`));
        });
        p.stdin.write(stdin);
        p.stdin.end();
      });
    }
    // No stdin: execFile is sufficient and spawns exactly once.
    return realExecFileAsync(file, args, {
      // No shell: execFile never spawns a shell.
      maxBuffer: 4 * 1024 * 1024,
    });
  },
};

// ---------------------------------------------------------------------------
// Pure command-plan builder.
// ---------------------------------------------------------------------------

export interface NetnsCommandPlan {
  /** Ordered `ip`/`nft` argv arrays. NEVER shell text. */
  readonly setup: ReadonlyArray<ReadonlyArray<string>>;
  /** Initial nft ruleset fed to `ip netns exec <name> nft -f -`. Default-drop. */
  readonly initialNftRules: ReadonlyArray<string>;
  /**
   * Build the ruleset that atomically replaces the session table so output
   * allows NEW TCP only to proxyIp:proxyListenPort and input permits the
   * established return. The port is baked in as a literal so the read-back
   * can require the exact rule.
   */
  authorizeProxyRules(proxyListenPort: number): ReadonlyArray<string>;
}

export interface BuildNetnsCommandsOptions {
  /** Kernel-visible namespace name. */
  name: string;
  /** Host-side veth interface name (<=15 bytes). */
  hostIf: string;
  /** Skill-side veth interface name (<=15 bytes). */
  skillIf: string;
  /** Link-local IPv4 for the proxy (e.g. `169.254.7.1`). */
  proxyIp: string;
  /** Link-local IPv4 for the skill side (e.g. `169.254.7.2`). */
  skillIp: string;
  /** Session nft table name. */
  nftTable: string;
}

const LINK_LOCAL_RE = /^169\.254\.(\d{1,3})\.(\d{1,3})$/;

function assertLinkLocal(ip: string, what: string): void {
  const m = LINK_LOCAL_RE.exec(ip);
  if (!m) {
    throw new NetnsError(`${what} must be a link-local 169.254.x.y address, got '${ip}'`);
  }
  const third = Number(m[1]);
  const fourth = Number(m[2]);
  if (third > 255 || fourth > 255 || fourth === 0 || fourth === 255) {
    throw new NetnsError(`${what} must be a valid 169.254.x.y host address, got '${ip}'`);
  }
}

function assertIfName(name: string, what: string): void {
  if (name.length === 0 || name.length > 15) {
    throw new NetnsError(`${what} must be 1..15 bytes, got ${name.length} ('${name}')`);
  }
  if (!/^[A-Za-z0-9_-]+$/.test(name)) {
    throw new NetnsError(`${what} contains invalid characters: '${name}'`);
  }
}

function buildInitialNftRules(nftTable: string): string[] {
  // Default-drop posture. Loopback + established/related only. A forward-hook
  // default-drop chain is declared so forwarded traffic is dropped by policy
  // (it does NOT enable IP forwarding — that is controlled by the
  // net.ipv4.ip_forward sysctl, which this code never touches). No NAT chain,
  // no egress allow — the proxy endpoint is authorized later via an atomic
  // replace that re-declares the forward chain.
  return [
    `table inet ${nftTable} {`,
    `  chain input {`,
    `    type filter hook input priority 0; policy drop;`,
    `    iifname "lo" accept`,
    `    ct state established,related accept`,
    `  }`,
    `  chain forward {`,
    `    type filter hook forward priority 0; policy drop;`,
    `  }`,
    `  chain output {`,
    `    type filter hook output priority 0; policy drop;`,
    `    oifname "lo" accept`,
    `    ct state established,related accept`,
    `  }`,
    `}`,
  ];
}

function buildAuthorizeProxyRules(
  nftTable: string,
  proxyIp: string,
  proxyListenPort: number,
): string[] {
  if (!Number.isInteger(proxyListenPort) || proxyListenPort <= 0 || proxyListenPort > 65535) {
    throw new NetnsError(`proxyListenPort must be an integer in 1..65535, got ${proxyListenPort}`);
  }
  // Atomic replace of the same table. Output allows NEW TCP only to
  // proxyIp:proxyListenPort; input permits the established return. Drop
  // everything else. The forward-hook default-drop chain is re-declared here
  // because the atomic replace drops the whole table — omitting it would
  // remove the forward default-drop. No NAT, no accept rule in the forward
  // chain, no sysctl mutation.
  return [
    `table inet ${nftTable} {`,
    `  chain input {`,
    `    type filter hook input priority 0; policy drop;`,
    `    iifname "lo" accept`,
    `    ct state established,related accept`,
    `    ip saddr ${proxyIp} tcp sport ${proxyListenPort} accept`,
    `  }`,
    `  chain forward {`,
    `    type filter hook forward priority 0; policy drop;`,
    `  }`,
    `  chain output {`,
    `    type filter hook output priority 0; policy drop;`,
    `    oifname "lo" accept`,
    `    ct state established,related accept`,
    `    ip daddr ${proxyIp} tcp dport ${proxyListenPort} accept`,
    `  }`,
    `}`,
  ];
}

/**
 * Pure command-plan builder. Returns the argv arrays and nft ruleset text the
 * real setup will execute. Never invokes a shell; never references sysctl,
 * ip_forward, unshare --net, masquerade, snat, or dnat. The ruleset declares
 * a forward-hook default-drop chain (policy drop, no accept rule) — this
 * drops forwarded traffic but does NOT enable IP forwarding, which is
 * controlled by net.ipv4.ip_forward and is never mutated here.
 */
export function buildNetnsCommands(opts: BuildNetnsCommandsOptions): NetnsCommandPlan {
  assertIfName(opts.hostIf, 'hostIf');
  assertIfName(opts.skillIf, 'skillIf');
  if (!opts.name || opts.name.length > 64 || !/^[A-Za-z0-9_.-]+$/.test(opts.name)) {
    throw new NetnsError(`netns name is invalid: '${opts.name}'`);
  }
  if (!opts.nftTable || !/^[A-Za-z0-9_]+$/.test(opts.nftTable)) {
    throw new NetnsError(`nftTable is invalid: '${opts.nftTable}'`);
  }
  assertLinkLocal(opts.proxyIp, 'proxyIp');
  assertLinkLocal(opts.skillIp, 'skillIp');
  if (opts.proxyIp === opts.skillIp) {
    throw new NetnsError(`proxyIp and skillIp must differ, both are '${opts.proxyIp}'`);
  }

  const setup: string[][] = [
    ['ip', 'netns', 'add', opts.name],
    ['ip', 'link', 'add', opts.hostIf, 'type', 'veth', 'peer', 'name', opts.skillIf],
    ['ip', 'link', 'set', opts.skillIf, 'netns', opts.name],
    ['ip', 'addr', 'add', `${opts.proxyIp}/32`, 'peer', `${opts.skillIp}/32`, 'dev', opts.hostIf],
    ['ip', 'netns', 'exec', opts.name, 'ip', 'addr', 'add', `${opts.skillIp}/32`, 'peer', `${opts.proxyIp}/32`, 'dev', opts.skillIf],
    ['ip', 'link', 'set', opts.hostIf, 'up'],
    ['ip', 'netns', 'exec', opts.name, 'ip', 'link', 'set', 'lo', 'up'],
    ['ip', 'netns', 'exec', opts.name, 'ip', 'link', 'set', opts.skillIf, 'up'],
  ];

  return {
    setup,
    initialNftRules: buildInitialNftRules(opts.nftTable),
    authorizeProxyRules: (proxyListenPort: number) =>
      buildAuthorizeProxyRules(opts.nftTable, opts.proxyIp, proxyListenPort),
  };
}

// ---------------------------------------------------------------------------
// Real setup / authorize / cleanup.
// ---------------------------------------------------------------------------

export interface SetupNetnsOptions {
  /** Session identifier used to derive collision-resistant names/addresses. */
  sessionId: string;
  /** Injectable exec seam. Defaults to the real execFile/spawn wrapper. */
  exec?: NetnsExec;
}

function sanitizeSessionId(sessionId: string): string {
  const s = sessionId.replace(/[^A-Za-z0-9_-]/g, '_').replace(/^_+|_+$/g, '');
  return s.length > 0 ? s.slice(0, 24) : 'anon';
}

function deriveNames(sessionId: string): { name: string; hostIf: string; skillIf: string; nftTable: string } {
  const salt = crypto.randomBytes(4).toString('hex');
  const san = sanitizeSessionId(sessionId);
  const name = `octn-${san}-${salt}`.slice(0, 64);
  const hostIf = `oh${salt}`.slice(0, 15);
  const skillIf = `os${salt}`.slice(0, 15);
  const nftTable = `oct_${salt}`;
  return { name, hostIf, skillIf, nftTable };
}

function deriveLinkLocalPair(sessionId: string): { proxyIp: string; skillIp: string } {
  // Use HMAC of sessionId + random salt to pick a /24 in 169.254.0.0/16.
  // We retry with a fresh salt on conflict.
  for (let attempt = 0; attempt < 32; attempt++) {
    const salt = crypto.randomBytes(8);
    const h = crypto.createHash('sha256').update(sessionId).update(salt).digest();
    const third = h[0]; // 0..255
    // Avoid 0 and 255 in the third octet for tidiness; the /32 host part is
    // always .1 (proxy) and .2 (skill).
    if (third === 0 || third === 255) continue;
    return {
      proxyIp: `169.254.${third}.1`,
      skillIp: `169.254.${third}.2`,
    };
  }
  throw new NetnsError('could not derive a link-local pair after 32 attempts');
}

/**
 * Bind a socket to proxyIp:0 on the host side, read the assigned ephemeral
 * port, close the socket, and return the port. The launcher later rebinds
 * the proxy to proxyIp:proxyPort.
 */
async function allocateProxyPortReal(proxyIp: string): Promise<number> {
  return await new Promise<number>((resolve, reject) => {
    const srv = net.createServer();
    srv.once('error', reject);
    srv.listen(0, proxyIp, () => {
      const addr = srv.address();
      if (addr === null || typeof addr === 'string') {
        srv.close(() => reject(new NetnsError(`could not allocate ephemeral port on ${proxyIp}`)));
        return;
      }
      const port = addr.port;
      srv.close((err) => {
        if (err) reject(err);
        else resolve(port);
      });
    });
  });
}

async function allocateProxyPort(exec: NetnsExec, proxyIp: string): Promise<number> {
  if (exec.allocatePort) return exec.allocatePort(proxyIp);
  return allocateProxyPortReal(proxyIp);
}

async function run(exec: NetnsExec, argv: string[], stdin?: string): Promise<{ stdout: string; stderr: string }> {
  try {
    return await exec.execFile(argv, stdin);
  } catch (err) {
    throw new NetnsError(`command failed: ${argv.join(' ')}: ${(err as Error).message}`, { cause: err });
  }
}

/**
 * Create the named netns, veth pair, /32 routes, session nft table, and
 * allocate the proxy listen port. Transactional + fail-closed: any error
 * tears down the partial namespace and throws.
 */
export async function setupNetns(opts: SetupNetnsOptions): Promise<NetnsHandle> {
  const exec = opts.exec ?? realNetnsExec;
  if (!opts.sessionId || typeof opts.sessionId !== 'string') {
    throw new NetnsError('sessionId is required');
  }

  const { name, hostIf, skillIf, nftTable } = deriveNames(opts.sessionId);
  const { proxyIp, skillIp } = deriveLinkLocalPair(opts.sessionId);

  const plan = buildNetnsCommands({ name, hostIf, skillIf, proxyIp, skillIp, nftTable });

  let cleanedUp = false;
  const cleanupErrors: Array<{ argv: string[]; error: string }> = [];

  const cleanup = async (): Promise<void> => {
    if (cleanedUp) return;
    cleanedUp = true;
    // Best-effort delete of ONLY this session's objects. We distinguish:
    //   - already-absent own objects (ENOENT / "No such file" / "Cannot find")
    //     → success, NOT recorded.
    //   - any OTHER teardown error (EBUSY, EPERM, still-in-use) → recorded in
    //     `cleanupErrors` so callers can surface the leak. We still continue
    //     teardown of the remaining objects — cleanup is idempotent.
    // We never run sysctl, never touch shared tables, and never `|| true` a
    // SETUP failure (only cleanup is best-effort).
    const isAlreadyAbsent = (msg: string): boolean =>
      /ENOENT|No such file|Cannot find|does not exist|not exist|No such process/i.test(msg);
    const tryExec = async (argv: string[]): Promise<void> => {
      try {
        await exec.execFile(argv);
      } catch (err) {
        const msg = (err as Error).message;
        if (!isAlreadyAbsent(msg)) {
          cleanupErrors.push({ argv: [...argv], error: msg });
        }
      }
    };
    await tryExec(['ip', 'netns', 'exec', name, 'nft', 'delete', 'table', 'inet', nftTable]);
    await tryExec(['ip', 'link', 'delete', hostIf]);
    await tryExec(['ip', 'netns', 'delete', name]);
  };

  try {
    // Steps 1-3: netns + veth + move peer + /32 addrs + bring up.
    for (const argv of plan.setup) {
      await run(exec, [...argv]);
    }

    // Step 4: install the fail-closed base nft table inside the named netns.
    const initialRules = plan.initialNftRules.join('\n') + '\n';
    await run(exec, ['ip', 'netns', 'exec', name, 'nft', '-f', '-'], initialRules);

    // Step 5: allocate the proxy listen port on the host side of the veth.
    const proxyPort = await allocateProxyPort(exec, proxyIp);

    const handle: NetnsHandle = {
      name,
      path: `/run/netns/${name}`,
      hostIf,
      skillIf,
      proxyIp,
      skillIp,
      proxyPort,
      nftTable,
      cleanupErrors,
      cleanup,
    };
    return handle;
  } catch (err) {
    await cleanup();
    if (err instanceof NetnsError) throw err;
    throw new NetnsError(`setupNetns failed: ${(err as Error).message}`, { cause: err });
  }
}

export interface AuthorizeProxyEndpointOptions {
  /** Must equal handle.proxyPort. A mismatch is fatal. */
  proxyListenPort: number;
  /** Injectable exec seam. Defaults to the real execFile/spawn wrapper. */
  exec?: NetnsExec;
}

/**
 * Atomically replace the session table so output allows NEW TCP only to
 * proxyIp:proxyListenPort and input permits the established return. Read the
 * table back with `nft -j list` and REQUIRE the exact port/address rule.
 * Returns the handle unchanged.
 */
export async function authorizeProxyEndpoint(
  handle: NetnsHandle,
  opts: AuthorizeProxyEndpointOptions,
): Promise<NetnsHandle> {
  const exec = opts.exec ?? realNetnsExec;

  if (opts.proxyListenPort !== handle.proxyPort) {
    throw new NetnsError(
      `proxyListenPort mismatch: caller passed ${opts.proxyListenPort} but handle.proxyPort is ${handle.proxyPort}`,
    );
  }
  if (!Number.isInteger(opts.proxyListenPort) || opts.proxyListenPort <= 0 || opts.proxyListenPort > 65535) {
    throw new NetnsError(`proxyListenPort must be an integer in 1..65535, got ${opts.proxyListenPort}`);
  }

  const plan = buildNetnsCommands({
    name: handle.name,
    hostIf: handle.hostIf,
    skillIf: handle.skillIf,
    proxyIp: handle.proxyIp,
    skillIp: handle.skillIp,
    nftTable: handle.nftTable,
  });
  const rules = plan.authorizeProxyRules(opts.proxyListenPort).join('\n') + '\n';

  // Atomic replace via `nft -f -` inside the named netns.
  await run(exec, ['ip', 'netns', 'exec', handle.name, 'nft', '-f', '-'], rules);

  // Read-back: list the table and REQUIRE the exact port/address rule.
  const { stdout } = await run(exec, [
    'ip', 'netns', 'exec', handle.name, 'nft', '-j', 'list', 'table', 'inet', handle.nftTable,
  ]);

  let parsed: unknown;
  try {
    parsed = JSON.parse(stdout);
  } catch (err) {
    throw new NetnsError(`nft -j list returned unparseable JSON: ${(err as Error).message}`, { cause: err });
  }

  // Walk the parsed ruleset and require BOTH:
  //   - a rule in the OUTPUT chain matching ip daddr == proxyIp && tcp dport == port && accept
  //   - a rule in the INPUT  chain matching ip saddr == proxyIp && tcp sport == port && accept
  // Substring matching is not sufficient: a missing output rule or a port
  // string coincidentally matching an unrelated chain handle/priority/counter
  // must fail closed.
  const missing = findMissingProxyRules(parsed, handle.proxyIp, opts.proxyListenPort, handle.nftTable);
  if (missing.length > 0) {
    throw new NetnsError(
      `read-back verification failed: table inet ${handle.nftTable} is missing ` +
      `the exact allow rule(s): ${missing.join('; ')} — refusing to continue`,
    );
  }

  return handle;
}

// ---------------------------------------------------------------------------
// Read-back rule walker.
// ---------------------------------------------------------------------------

interface NftExprMatch {
  match?: {
    op?: string;
    left?: { payload?: { protocol?: string; field?: string } };
    right?: unknown;
  };
  accept?: unknown;
}

interface NftRule {
  rule?: {
    family?: string;
    table?: string;
    chain?: string;
    expr?: NftExprMatch[];
  };
}

interface NftChain {
  chain?: {
    family?: string;
    table?: string;
    name?: string;
    handle?: number;
    type?: string;
    hook?: string;
    /** nft -j emits `prio` (numeric, sometimes string) for the priority. */
    prio?: unknown;
    /** Some builds emit `priority` instead of `prio` — tolerate both. */
    priority?: unknown;
    policy?: string;
  };
}

/**
 * Inspect a parsed `nft -j list` dump and return a list of missing rules.
 * Returns an empty array when ALL of the following hold:
 *   - the output daddr/dport accept rule is present,
 *   - the input saddr/sport accept rule is present,
 *   - a `forward` base chain exists with `type filter`, `hook forward`,
 *     normalized priority === 0, and `policy drop`.
 *
 * Priority normalization: `Number(chain.prio ?? chain.priority) === 0`. nft
 * emits `prio` in JSON, but tolerate `priority` and string values ("0").
 */
function findMissingProxyRules(
  parsed: unknown,
  proxyIp: string,
  port: number,
  nftTable: string,
): string[] {
  const missing: string[] = [];
  const nftables = (parsed as { nftables?: unknown[] })?.nftables;
  if (!Array.isArray(nftables)) {
    return ['nftables array is absent — unparseable dump'];
  }

  let hasOutputRule = false;
  let hasInputRule = false;
  let forwardChainOk = false;

  for (const entry of nftables) {
    // Chain entry: `{ "chain": { family, table, name, handle, type, hook, prio, policy } }`.
    const chainEntry = (entry as NftChain)?.chain;
    if (chainEntry) {
      if (chainEntry.name === 'forward') {
        const typeOk = chainEntry.type === 'filter';
        const hookOk = chainEntry.hook === 'forward';
        const policyOk = chainEntry.policy === 'drop';
        const prioRaw = chainEntry.prio ?? chainEntry.priority;
        const prioOk = prioRaw !== undefined && prioRaw !== null && Number(prioRaw) === 0;
        // Fail closed if the forward chain exists but is malformed — surface a
        // precise reason so the operator can see which field is wrong.
        if (typeOk && hookOk && policyOk && prioOk) {
          forwardChainOk = true;
        } else {
          const reasons: string[] = [];
          if (!typeOk) reasons.push(`type=${chainEntry.type ?? '<missing>'}`);
          if (!hookOk) reasons.push(`hook=${chainEntry.hook ?? '<missing>'}`);
          if (!policyOk) reasons.push(`policy=${chainEntry.policy ?? '<missing>'}`);
          if (!prioOk) reasons.push(`prio=${prioRaw === undefined ? '<missing>' : JSON.stringify(prioRaw)}`);
          missing.push(`forward chain malformed: ${reasons.join(', ')}`);
        }
      }
      continue;
    }

    const rule = (entry as NftRule)?.rule;
    if (!rule || !Array.isArray(rule.expr)) continue;
    const chain = rule.chain;
    if (chain !== 'output' && chain !== 'input') continue;

    // Extract ip daddr/saddr and tcp dport/sport from this rule's expr.
    let ipAddr: string | undefined;
    let tcpPort: number | undefined;
    let hasAccept = false;

    for (const e of rule.expr) {
      if (e?.accept !== undefined) {
        hasAccept = true;
        continue;
      }
      const m = e?.match;
      if (!m) continue;
      const proto = m.left?.payload?.protocol;
      const field = m.left?.payload?.field;
      const right = m.right;
      if (proto === 'ip' && (field === 'daddr' || field === 'saddr') && typeof right === 'string') {
        ipAddr = right;
      } else if (proto === 'tcp' && (field === 'dport' || field === 'sport') && typeof right === 'number') {
        tcpPort = right;
      }
    }

    if (!hasAccept) continue;
    if (chain === 'output' && ipAddr === proxyIp && tcpPort === port) hasOutputRule = true;
    if (chain === 'input' && ipAddr === proxyIp && tcpPort === port) hasInputRule = true;
  }

  if (!hasOutputRule) {
    missing.push(`output chain rule: ip daddr ${proxyIp} tcp dport ${port} accept`);
  }
  if (!hasInputRule) {
    missing.push(`input chain rule: ip saddr ${proxyIp} tcp sport ${port} accept`);
  }
  if (!forwardChainOk) {
    // Only emit the "missing" reason if no malformed reason was already pushed.
    const hasForwardReason = missing.some((m) => m.startsWith('forward chain'));
    if (!hasForwardReason) {
      missing.push(`forward chain missing: table inet ${nftTable} must declare a 'forward' base chain with type filter, hook forward, priority 0, policy drop`);
    }
  }
  return missing;
}
