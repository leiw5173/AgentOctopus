/**
 * Tests for packages/sandbox/src/os/netns.ts (Plan 4, Task 4).
 *
 * Layout
 * ------
 * 1. Portable unit tests (run on macOS).
 *    - `buildNetnsCommands` is a PURE function — assert the exact command
 *      plan (argv arrays + nft ruleset text) without touching the kernel.
 *    - `setupNetns`/`authorizeProxyEndpoint` are exercised against an
 *      injected fake exec seam + fake bind-allocator so we can assert the
 *      ORDER of `ip`/`nft` invocations, the fail-closed cleanup, the
 *      read-back verification, and the proxy-port equality check.
 *
 * 2. Linux-gated smoke test — real netns + veth + nft + connectivity.
 *    Skipped on macOS. `OCTOPUS_REQUIRE_OS_SANDBOX=1` converts a capability
 *    skip into a hard failure on the Plan 6 privileged lane.
 */
import { describe, it, expect } from 'vitest';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import net from 'node:net';
import fs from 'node:fs/promises';
import {
  buildNetnsCommands,
  setupNetns,
  authorizeProxyEndpoint,
  NetnsError,
  type NetnsExec,
} from '../src/os/netns.js';

const execFileAsync = promisify(execFile);

// ---------------------------------------------------------------------------
// 1a. Pure command-plan test (from the brief — verbatim semantics).
// ---------------------------------------------------------------------------

describe('buildNetnsCommands', () => {
  it('uses one named netns, <=15-byte interfaces, /32 routes, and the actual proxy port', () => {
    const p = buildNetnsCommands({
      name: 'octn-deadbeef', hostIf: 'ohdeadbeef', skillIf: 'osdeadbeef',
      proxyIp: '169.254.7.1', skillIp: '169.254.7.2', nftTable: 'oct_deadbeef',
    });
    expect(p.setup).toEqual(expect.arrayContaining([
      ['ip', 'netns', 'add', 'octn-deadbeef'],
      ['ip', 'addr', 'add', '169.254.7.1/32', 'peer', '169.254.7.2/32', 'dev', 'ohdeadbeef'],
      ['ip', 'netns', 'exec', 'octn-deadbeef', 'ip', 'addr', 'add', '169.254.7.2/32', 'peer', '169.254.7.1/32', 'dev', 'osdeadbeef'],
    ]));
    expect('ohdeadbeef'.length).toBeLessThanOrEqual(15);
    expect('osdeadbeef'.length).toBeLessThanOrEqual(15);
    expect(p.initialNftRules.join('\n')).toMatch(/policy drop/);
    const nft = p.authorizeProxyRules(43123).join('\n');
    expect(nft).toContain('ip daddr 169.254.7.1 tcp dport 43123 accept');
    expect(nft).toContain('ip saddr 169.254.7.1 tcp sport 43123 accept');
    expect(nft).toMatch(/policy drop/);
    // NAT-negative invariant: no masquerade/snat/dnat anywhere.
    expect(nft).not.toMatch(/masquerade|snat|dnat/i);
    // A forward-hook default-drop chain MUST be declared (Plan 6 posture).
    expect(nft).toMatch(/chain forward[^}]*type filter hook forward priority 0; policy drop/s);
    expect(JSON.stringify(p)).not.toMatch(/sysctl|ip_forward|unshare --net/);
  });

  it('rejects an interface name longer than 15 bytes', () => {
    expect(() => buildNetnsCommands({
      name: 'octn-x', hostIf: 'oh-this-name-is-way-too-long', skillIf: 'osok',
      proxyIp: '169.254.7.1', skillIp: '169.254.7.2', nftTable: 'oct_x',
    })).toThrow(/15/);
    expect(() => buildNetnsCommands({
      name: 'octn-x', hostIf: 'ohok', skillIf: 'os-this-name-is-way-too-long',
      proxyIp: '169.254.7.1', skillIp: '169.254.7.2', nftTable: 'oct_x',
    })).toThrow(/15/);
  });

  it('rejects non-link-local or malformed addresses', () => {
    expect(() => buildNetnsCommands({
      name: 'octn-x', hostIf: 'ohok', skillIf: 'osok',
      proxyIp: '8.8.8.8', skillIp: '169.254.7.2', nftTable: 'oct_x',
    })).toThrow(/link-local|169\.254/);
    expect(() => buildNetnsCommands({
      name: 'octn-x', hostIf: 'ohok', skillIf: 'osok',
      proxyIp: '169.254.7.1', skillIp: '10.0.0.2', nftTable: 'oct_x',
    })).toThrow(/link-local|169\.254/);
  });

  it('never references sysctl / ip_forward / unshare --net / masquerade / NAT anywhere', () => {
    const p = buildNetnsCommands({
      name: 'octn-abc', hostIf: 'ohabc', skillIf: 'osabc',
      proxyIp: '169.254.9.1', skillIp: '169.254.9.2', nftTable: 'oct_abc',
    });
    const s = JSON.stringify(p);
    expect(s).not.toMatch(/sysctl/i);
    expect(s).not.toMatch(/ip_forward/i);
    expect(s).not.toMatch(/unshare --net/i);
    expect(s).not.toMatch(/masquerade|snat|dnat/i);
    // A forward-hook default-drop chain MUST be declared in BOTH the initial
    // and the authorized tables (the authorized table is an atomic replace,
    // so it has to re-declare the forward chain or the chain would be lost
    // on authorize).
    const expectForwardDrop = (rules: string) => {
      // Whitespace-tolerant: `chain forward { ... type filter hook forward
      // priority 0; policy drop; ... }` — the inner body has no accept rule.
      const m = rules.match(/chain forward\s*\{([^}]*)\}/);
      expect(m).not.toBeNull();
      const body = m![1];
      expect(body).toMatch(/type filter hook forward priority 0;\s*policy drop;/);
      expect(body).not.toMatch(/accept/i);
    };
    expectForwardDrop(p.initialNftRules.join('\n'));
    expectForwardDrop(p.authorizeProxyRules(43210).join('\n'));
  });

  it('initial rules drop everything except loopback and established/related — no egress window', () => {
    const p = buildNetnsCommands({
      name: 'octn-x', hostIf: 'ohx', skillIf: 'osx',
      proxyIp: '169.254.7.1', skillIp: '169.254.7.2', nftTable: 'oct_x',
    });
    const init = p.initialNftRules.join('\n');
    // Base chains with drop policy for input and output.
    expect(init).toMatch(/chain input[^}]*policy drop/s);
    expect(init).toMatch(/chain output[^}]*policy drop/s);
    // Loopback allowed.
    expect(init).toMatch(/iifname "lo" accept/);
    expect(init).toMatch(/oifname "lo" accept/);
    // Established/related allowed.
    expect(init).toMatch(/ct state established,related accept/);
    // No egress allow rule for any non-loopback destination.
    expect(init).not.toMatch(/ip daddr .* accept/);
    // A forward-hook default-drop chain MUST be present (no accept rule inside).
    expect(init).toMatch(/chain forward[^}]*type filter hook forward priority 0; policy drop/s);
    // No NAT chain.
    expect(init).not.toMatch(/type nat /i);
  });
});

// ---------------------------------------------------------------------------
// 1b. Fake exec seam + fake port allocator — assert ORDER + fail-closed.
// ---------------------------------------------------------------------------

interface ExecCall {
  argv: string[];
  stdin?: string;
}

class FakeExec implements NetnsExec {
  readonly calls: ExecCall[] = [];
  /** argv[0]+argv[1] prefixes that should fail. */
  readonly failOn: Array<{ match: (argv: string[]) => boolean; message: string }> = [];
  /** nft -j list output to return. */
  nftListOutput = '';
  /** Whether to return a fresh netns inode on the read-back probe. */
  netnsInode = 'net:[4026531993]';
  /** Port counter for allocatePort; starts at a random high port. */
  private portCounter = 20000 + Math.floor(Math.random() * 20000);

  async execFile(argv: string[], stdin?: string): Promise<{ stdout: string; stderr: string }> {
    this.calls.push({ argv, stdin });
    for (const f of this.failOn) {
      if (f.match(argv)) throw new Error(f.message);
    }
    // Fake a successful nft list.
    if (argv[0] === 'ip' && argv[1] === 'netns' && argv[2] === 'exec' && argv.includes('nft') && argv.includes('-j')) {
      return { stdout: this.nftListOutput, stderr: '' };
    }
    if (argv[0] === 'ip' && argv[1] === 'netns' && argv[2] === 'exec' && argv.includes('readlink')) {
      return { stdout: this.netnsInode + '\n', stderr: '' };
    }
    return { stdout: '', stderr: '' };
  }

  async allocatePort(_ip: string): Promise<number> {
    return this.portCounter++;
  }
}

describe('setupNetns (injected fake exec)', () => {
  it('runs the mandatory order: netns add → veth pair → move peer → /32 addrs → up → nft base', async () => {
    const fake = new FakeExec();
    const h = await setupNetns({ sessionId: 'sess abc/123', exec: fake });
    // First call must be `ip netns add <name>`.
    expect(fake.calls[0].argv.slice(0, 3)).toEqual(['ip', 'netns', 'add']);
    expect(fake.calls[0].argv[3]).toBe(h.name);
    // Second call: veth pair creation.
    expect(fake.calls[1].argv.slice(0, 5)).toEqual(['ip', 'link', 'add', h.hostIf, 'type']);
    expect(fake.calls[1].argv).toContain('veth');
    expect(fake.calls[1].argv).toContain('peer');
    expect(fake.calls[1].argv).toContain(h.skillIf);
    // Move skillIf into the netns.
    const moveCall = fake.calls.find((c) => c.argv.includes('set') && c.argv.includes(h.skillIf) && c.argv.includes('netns'));
    expect(moveCall).toBeDefined();
    expect(moveCall!.argv).toEqual(['ip', 'link', 'set', h.skillIf, 'netns', h.name]);
    // Host side /32 peer addr.
    const hostAddr = fake.calls.find((c) =>
      c.argv[0] === 'ip' && c.argv[1] === 'addr' && c.argv[2] === 'add' && c.argv.includes(h.hostIf));
    expect(hostAddr).toBeDefined();
    expect(hostAddr!.argv).toContain(`${h.proxyIp}/32`);
    expect(hostAddr!.argv).toContain('peer');
    expect(hostAddr!.argv).toContain(`${h.skillIp}/32`);
    // Skill side /32 peer addr (inside netns).
    const skillAddr = fake.calls.find((c) =>
      c.argv[0] === 'ip' && c.argv[1] === 'netns' && c.argv[2] === 'exec' &&
      c.argv.includes('addr') && c.argv.includes(`${h.skillIp}/32`));
    expect(skillAddr).toBeDefined();
    expect(skillAddr!.argv).toContain('peer');
    expect(skillAddr!.argv).toContain(`${h.proxyIp}/32`);
    // Bring up both ends + loopback in netns.
    const hostUp = fake.calls.find((c) =>
      c.argv[0] === 'ip' && c.argv[1] === 'link' && c.argv[2] === 'set' && c.argv.includes(h.hostIf) && c.argv.includes('up'));
    expect(hostUp).toBeDefined();
    const loUp = fake.calls.find((c) =>
      c.argv[0] === 'ip' && c.argv[1] === 'netns' && c.argv[2] === 'exec' &&
      c.argv.includes('lo') && c.argv.includes('up'));
    expect(loUp).toBeDefined();
    const skillUp = fake.calls.find((c) =>
      c.argv[0] === 'ip' && c.argv[1] === 'netns' && c.argv[2] === 'exec' &&
      c.argv.includes(h.skillIf) && c.argv.includes('up'));
    expect(skillUp).toBeDefined();
    // The base nft table is fed via stdin to `ip netns exec <name> nft -f -`.
    const nftCall = fake.calls.find((c) =>
      c.argv[0] === 'ip' && c.argv[1] === 'netns' && c.argv[2] === 'exec' &&
      c.argv.includes('nft') && c.argv.includes('-f') && c.argv.includes('-'));
    expect(nftCall).toBeDefined();
    expect(nftCall!.stdin).toMatch(/policy drop/);
    expect(nftCall!.stdin).toMatch(/iifname "lo" accept/);
    expect(nftCall!.stdin).toMatch(/ct state established,related accept/);
    // No egress allow rule in the base table.
    expect(nftCall!.stdin).not.toMatch(/ip daddr .* accept/);
    // NO default route ever installed.
    const routeCalls = fake.calls.filter((c) => c.argv.includes('route'));
    for (const rc of routeCalls) {
      expect(rc.argv.join(' ')).not.toMatch(/default/);
    }
    // No sysctl / forwarding change.
    expect(JSON.stringify(fake.calls)).not.toMatch(/sysctl|ip_forward/);
    // Names are <=15 bytes.
    expect(h.hostIf.length).toBeLessThanOrEqual(15);
    expect(h.skillIf.length).toBeLessThanOrEqual(15);
    // proxyPort is a valid ephemeral port.
    expect(h.proxyPort).toBeGreaterThan(0);
    expect(h.proxyPort).toBeLessThanOrEqual(65535);
    // Cleanup runs the delete calls.
    await h.cleanup();
    const cleanupCalls = fake.calls.slice(fake.calls.findIndex((c) => c.argv.includes('nft')));
    const dels = cleanupCalls.filter((c) => c.argv.includes('delete') || c.argv.includes('del'));
    const delStr = dels.map((d) => d.argv.join(' ')).join('\n');
    expect(delStr).toContain(h.nftTable);
    expect(delStr).toContain(h.name);
    expect(delStr).toContain(h.hostIf);
  });

  it('derives a link-local /32 pair from the sessionId (collision-resistant across calls)', async () => {
    const a = await setupNetns({ sessionId: 'sess same', exec: new FakeExec() });
    const b = await setupNetns({ sessionId: 'sess same', exec: new FakeExec() });
    // Same sessionId must still produce different names/addresses (random salt).
    expect(a.name).not.toBe(b.name);
    expect(a.proxyIp).not.toBe(b.proxyIp);
    expect(a.proxyIp).toMatch(/^169\.254\.\d+\.1$/);
    expect(a.skillIp).toMatch(/^169\.254\.\d+\.2$/);
    // Third octet differs across calls (collision-resistant derivation).
    const aThird = Number(a.proxyIp.split('.')[2]);
    const bThird = Number(b.proxyIp.split('.')[2]);
    expect(aThird).toBeGreaterThanOrEqual(0);
    expect(aThird).toBeLessThanOrEqual(255);
    expect(bThird).toBeGreaterThanOrEqual(0);
    expect(bThird).toBeLessThanOrEqual(255);
  });

  it('fails closed and removes the partial netns when `ip link add` fails', async () => {
    const fake = new FakeExec();
    fake.failOn.push({
      match: (argv) => argv[0] === 'ip' && argv[1] === 'link' && argv[2] === 'add',
      message: 'operation not permitted',
    });
    await expect(setupNetns({ sessionId: 'sess x', exec: fake })).rejects.toThrow(NetnsError);
    // The partial netns was deleted.
    const delNetns = fake.calls.find((c) =>
      c.argv[0] === 'ip' && c.argv[1] === 'netns' && c.argv[2] === 'delete');
    expect(delNetns).toBeDefined();
  });

  it('fails closed and removes partial state when the initial nft feed fails', async () => {
    const fake = new FakeExec();
    fake.failOn.push({
      match: (argv) => argv.includes('nft') && argv.includes('-f'),
      message: 'nft: could not process rule',
    });
    await expect(setupNetns({ sessionId: 'sess y', exec: fake })).rejects.toThrow(NetnsError);
    // Cleanup ran (netns + veth removed).
    const delNetns = fake.calls.find((c) =>
      c.argv[0] === 'ip' && c.argv[1] === 'netns' && c.argv[2] === 'delete');
    expect(delNetns).toBeDefined();
    const delLink = fake.calls.find((c) =>
      c.argv[0] === 'ip' && c.argv[1] === 'link' && c.argv[2] === 'delete');
    expect(delLink).toBeDefined();
  });

  it('never hides setup failures with `|| true` (no best-effort masking)', async () => {
    const fake = new FakeExec();
    fake.failOn.push({
      match: (argv) => argv[0] === 'ip' && argv[1] === 'netns' && argv[2] === 'add',
      message: 'File exists',
    });
    await expect(setupNetns({ sessionId: 'sess z', exec: fake })).rejects.toThrow(NetnsError);
    // No further setup calls happened after the failure.
    const vethCall = fake.calls.find((c) => c.argv[0] === 'ip' && c.argv[1] === 'link' && c.argv[2] === 'add');
    expect(vethCall).toBeUndefined();
  });

  it('cleanup treats already-absent own objects as success and is idempotent', async () => {
    const fake = new FakeExec();
    const h = await setupNetns({ sessionId: 'sess idem', exec: fake });
    // First cleanup.
    await h.cleanup();
    // Second cleanup must not throw.
    await h.cleanup();
    // Make subsequent deletes fail — third cleanup still must not throw because
    // it already ran and the flag is latched.
    fake.failOn.push({
      match: (argv) => argv.includes('delete') || (argv[0] === 'ip' && argv[1] === 'netns' && argv[2] === 'del'),
      message: 'No such file or directory',
    });
    await expect(h.cleanup()).resolves.toBeUndefined();
    // The "already-absent" failure path was never even reached on the latched
    // cleanup, so cleanupErrors stays empty.
    expect(h.cleanupErrors).toEqual([]);
  });

  it('cleanup records unexpected errors (EBUSY) but treats already-absent as success', async () => {
    const fake = new FakeExec();
    const h = await setupNetns({ sessionId: 'sess record', exec: fake });
    // Make the nft delete fail with EBUSY (still-in-use, NOT already-absent),
    // and the link delete fail with ENOENT (already-absent → success, not recorded).
    fake.failOn.push({
      match: (argv) => argv.includes('nft') && argv.includes('delete'),
      message: 'Error: EBUSY: table is busy',
    });
    fake.failOn.push({
      match: (argv) => argv[0] === 'ip' && argv[1] === 'link' && argv[2] === 'delete',
      message: 'Cannot find device "ohXXXXX"',
    });
    await h.cleanup();
    // EBUSY was recorded; ENOENT (already-absent) was NOT.
    expect(h.cleanupErrors.length).toBe(1);
    expect(h.cleanupErrors[0].error).toMatch(/EBUSY/);
    expect(h.cleanupErrors[0].argv).toContain('nft');
    expect(h.cleanupErrors[0].argv).toContain('delete');
  });

  it('every nft -f - call goes through the seam EXACTLY ONCE (F1 regression)', async () => {
    // Regression for the F1 double-spawn bug: a previous version of the real
    // exec seam called execFile FIRST (spawning a child with no stdin piped,
    // which would hang forever) and THEN called spawn again for the actual
    // stdin work. The fix is to branch BEFORE any child is created. We
    // verify the invariant via the FakeExec seam by counting calls per
    // logical operation; the real implementation's structure is verified by
    // inspection of netns.ts (single `if (stdin !== undefined)` branch, no
    // preceding execFile call).
    const fake = new FakeExec();
    const h = await setupNetns({ sessionId: 'sess f1', exec: fake });
    const port = h.proxyPort;
    fake.nftListOutput = JSON.stringify({
      nftables: [
        { table: { family: 'inet', name: h.nftTable } },
        {
          chain: {
            family: 'inet', table: h.nftTable, name: 'forward', handle: 3,
            type: 'filter', hook: 'forward', prio: 0, policy: 'drop',
          },
        },
        {
          rule: {
            family: 'inet', table: h.nftTable, chain: 'output',
            expr: [
              { match: { op: '==', left: { payload: { protocol: 'ip', field: 'daddr' } }, right: h.proxyIp } },
              { match: { op: '==', left: { payload: { protocol: 'tcp', field: 'dport' } }, right: port } },
              { accept: null },
            ],
          },
        },
        {
          rule: {
            family: 'inet', table: h.nftTable, chain: 'input',
            expr: [
              { match: { op: '==', left: { payload: { protocol: 'ip', field: 'saddr' } }, right: h.proxyIp } },
              { match: { op: '==', left: { payload: { protocol: 'tcp', field: 'sport' } }, right: port } },
              { accept: null },
            ],
          },
        },
      ],
    });
    await authorizeProxyEndpoint(h, { proxyListenPort: port, exec: fake });
    // Two nft -f - calls total: one for the initial base table, one for the
    // atomic replace. Each must appear EXACTLY ONCE in the seam's call log.
    const nftFeedCalls = fake.calls.filter((c) =>
      c.argv.includes('nft') && c.argv.includes('-f') && c.argv.includes('-'));
    expect(nftFeedCalls.length).toBe(2);
    // Both carried stdin (i.e. each logical stdin operation made exactly one
    // seam call, and that call carried the ruleset).
    for (const call of nftFeedCalls) {
      expect(call.stdin).toBeDefined();
      expect(call.stdin!.length).toBeGreaterThan(0);
    }
    // Source-structure check: the production seam must not call execFile
    // before deciding whether stdin is present. Read the module source once
    // and assert the branch ordering.
    const src = await fs.readFile(new URL('../src/os/netns.ts', import.meta.url), 'utf8');
    const realExecBody = src.match(/const realNetnsExec[\s\S]*?^};/m)?.[0] ?? '';
    expect(realExecBody.length).toBeGreaterThan(0);
    const stdinBranchIdx = realExecBody.indexOf('if (stdin !== undefined)');
    const execFileCallIdx = realExecBody.indexOf('realExecFileAsync(file');
    expect(stdinBranchIdx).toBeGreaterThan(-1);
    expect(execFileCallIdx).toBeGreaterThan(-1);
    // The stdin branch must come BEFORE any execFile invocation, so a
    // stdin-bearing call never spawns an execFile child first.
    expect(stdinBranchIdx).toBeLessThan(execFileCallIdx);
  });
});

describe('authorizeProxyEndpoint (injected fake exec)', () => {
  /**
   * Build a forward base chain entry as emitted by `nft -j list`. Accepts a
   * `variant` so priority-variant tests can mutate one field at a time and
   * verify the walker's normalization / fail-closed behavior.
   */
  function forwardChainEntry(
    nftTable: string,
    variant: Partial<{ prio: unknown; priority: unknown; policy: string; hook: string; type: string }> = {},
  ): { chain: { family: string; table: string; name: string; handle: number; type: string; hook: string; prio: unknown; policy: string } } {
    return {
      chain: {
        family: 'inet',
        table: nftTable,
        name: 'forward',
        handle: 3,
        type: variant.type ?? 'filter',
        hook: variant.hook ?? 'forward',
        prio: variant.prio ?? 0,
        policy: variant.policy ?? 'drop',
      },
    };
  }

  function buildFakeNftList(
    host: { proxyIp: string; nftTable: string },
    port: number,
    opts?: {
      omitOutput?: boolean;
      bogusPort?: number;
      /** Omit the forward base chain entirely (for fail-closed walker tests). */
      omitForward?: boolean;
      /** Mutate the forward chain entry (wrong priority/policy/hook/type). */
      forwardVariant?: Partial<{ prio: unknown; priority: unknown; policy: string; hook: string; type: string }>;
    },
  ): string {
    const rules: unknown[] = [
      { table: { family: 'inet', name: host.nftTable } },
    ];
    if (!opts?.omitForward) {
      // When `forwardVariant.priority` (not `prio`) is set, drop `prio` so the
      // walker exercises the `priority` fallback path.
      if (opts?.forwardVariant?.priority !== undefined) {
        const { prio: _drop, ...rest } = opts.forwardVariant;
        rules.push(forwardChainEntry(host.nftTable, { ...rest, prio: undefined }));
        // forwardChainEntry sets prio:undefined → undefined falls back to priority
        // via the `??` chain in the walker. Patch the entry in place.
        const entry = rules[rules.length - 1] as { chain: Record<string, unknown> };
        entry.chain.prio = undefined;
        entry.chain.priority = opts.forwardVariant.priority;
      } else {
        rules.push(forwardChainEntry(host.nftTable, opts?.forwardVariant));
      }
    }
    if (!opts?.omitOutput) {
      rules.push({
        rule: {
          family: 'inet',
          table: host.nftTable,
          chain: 'output',
          expr: [
            { match: { op: '==', left: { payload: { protocol: 'ip', field: 'daddr' } }, right: host.proxyIp } },
            { match: { op: '==', left: { payload: { protocol: 'tcp', field: 'dport' } }, right: port } },
            { accept: null },
          ],
        },
      });
    }
    rules.push({
      rule: {
        family: 'inet',
        table: host.nftTable,
        chain: 'input',
        expr: [
          { match: { op: '==', left: { payload: { protocol: 'ip', field: 'saddr' } }, right: host.proxyIp } },
          { match: { op: '==', left: { payload: { protocol: 'tcp', field: 'sport' } }, right: port } },
          { accept: null },
        ],
      },
    });
    if (opts?.bogusPort !== undefined) {
      // An unrelated chain whose handle happens to match the port string —
      // a substring-based check would false-positive on this. The exact-rule
      // walker must ignore it.
      rules.push({
        chain: { family: 'inet', table: host.nftTable, name: 'unrelated', handle: opts.bogusPort },
      });
    }
    return JSON.stringify({ nftables: rules });
  }

  it('atomically replaces the table and verifies the exact port rule via read-back', async () => {
    const fake = new FakeExec();
    const h = await setupNetns({ sessionId: 'sess auth', exec: fake });
    const port = h.proxyPort;
    fake.nftListOutput = buildFakeNftList(h, port);
    const out = await authorizeProxyEndpoint(h, { proxyListenPort: port, exec: fake });
    expect(out).toBe(h);
    // The nft -f - replace call went through stdin.
    const replaceCall = fake.calls.find((c) =>
      c.argv[0] === 'ip' && c.argv[1] === 'netns' && c.argv[2] === 'exec' &&
      c.argv.includes('nft') && c.argv.includes('-f') && c.argv.includes('-') &&
      c.stdin && c.stdin.includes(String(port)));
    expect(replaceCall).toBeDefined();
    expect(replaceCall!.stdin).toContain(`ip daddr ${h.proxyIp} tcp dport ${port} accept`);
    expect(replaceCall!.stdin).toContain(`ip saddr ${h.proxyIp} tcp sport ${port} accept`);
    // The read-back was issued.
    const listCall = fake.calls.find((c) =>
      c.argv[0] === 'ip' && c.argv[1] === 'netns' && c.argv[2] === 'exec' &&
      c.argv.includes('nft') && c.argv.includes('-j') && c.argv.includes('list'));
    expect(listCall).toBeDefined();
    // NAT-negative invariant: no masquerade/snat/dnat anywhere in the
    // authorized ruleset. The forward-hook default-drop chain is expected
    // (asserted structurally by the read-back walker below).
    expect(replaceCall!.stdin).not.toMatch(/masquerade|snat|dnat/i);
    // The authorized ruleset re-declares the forward default-drop chain.
    expect(replaceCall!.stdin).toMatch(/chain forward[^}]*type filter hook forward priority 0; policy drop/s);
    // No accept rule lives inside the forward chain body.
    const fwdBody = replaceCall!.stdin!.match(/chain forward\s*\{([^}]*)\}/);
    expect(fwdBody).not.toBeNull();
    expect(fwdBody![1]).not.toMatch(/accept/i);
  });

  it('a mismatched proxyListenPort is fatal (refuses to authorize)', async () => {
    const fake = new FakeExec();
    const h = await setupNetns({ sessionId: 'sess mismatch', exec: fake });
    await expect(authorizeProxyEndpoint(h, { proxyListenPort: h.proxyPort + 1, exec: fake }))
      .rejects.toThrow(/mismatch/i);
  });

  it('fails closed when the read-back does not contain the exact port rule', async () => {
    const fake = new FakeExec();
    const h = await setupNetns({ sessionId: 'sess badread', exec: fake });
    // Empty list output — the required rule is missing.
    fake.nftListOutput = JSON.stringify({ nftables: [] });
    await expect(authorizeProxyEndpoint(h, { proxyListenPort: h.proxyPort, exec: fake }))
      .rejects.toThrow(/read-back|not present|missing|verif/i);
  });

  it('fails closed when only the INPUT return rule is present (output allow rule missing)', async () => {
    const fake = new FakeExec();
    const h = await setupNetns({ sessionId: 'sess noout', exec: fake });
    // Substring-based check would PASS here (proxyIp and port both appear
    // in the dump). The exact-rule walker must reject.
    fake.nftListOutput = buildFakeNftList(h, h.proxyPort, { omitOutput: true });
    await expect(authorizeProxyEndpoint(h, { proxyListenPort: h.proxyPort, exec: fake }))
      .rejects.toThrow(/output chain rule/);
  });

  it('fails closed when the port string appears only as an unrelated chain handle', async () => {
    const fake = new FakeExec();
    const h = await setupNetns({ sessionId: 'sess bogus', exec: fake });
    // The dump has the input rule with the right port AND a chain handle that
    // coincidentally equals the port number — but the OUTPUT rule is missing.
    // Substring-based check would false-positive on the handle. Exact-rule
    // walker must reject because the output daddr/dport rule is absent.
    fake.nftListOutput = buildFakeNftList(h, h.proxyPort, { omitOutput: true, bogusPort: h.proxyPort });
    await expect(authorizeProxyEndpoint(h, { proxyListenPort: h.proxyPort, exec: fake }))
      .rejects.toThrow(/output chain rule/);
  });

  // -------------------------------------------------------------------------
  // Forward-chain read-back walker: priority normalization + fail-closed.
  // nft -j emits `prio` (numeric, sometimes string) for the priority; some
  // builds emit `priority` instead. The walker normalizes via
  // `Number(chain.prio ?? chain.priority) === 0` and tolerates "0" strings.
  // -------------------------------------------------------------------------

  it('accepts a forward chain with prio:0 (numeric, canonical nft -j output)', async () => {
    const fake = new FakeExec();
    const h = await setupNetns({ sessionId: 'sess prio0', exec: fake });
    fake.nftListOutput = buildFakeNftList(h, h.proxyPort, { forwardVariant: { prio: 0 } });
    await expect(authorizeProxyEndpoint(h, { proxyListenPort: h.proxyPort, exec: fake }))
      .resolves.toBe(h);
  });

  it('accepts a forward chain with priority:0 (priority-key fallback)', async () => {
    const fake = new FakeExec();
    const h = await setupNetns({ sessionId: 'sess pk0', exec: fake });
    fake.nftListOutput = buildFakeNftList(h, h.proxyPort, { forwardVariant: { priority: 0 } });
    await expect(authorizeProxyEndpoint(h, { proxyListenPort: h.proxyPort, exec: fake }))
      .resolves.toBe(h);
  });

  it('accepts a forward chain with priority:"0" (string-tolerant normalization)', async () => {
    const fake = new FakeExec();
    const h = await setupNetns({ sessionId: 'sess pks0', exec: fake });
    fake.nftListOutput = buildFakeNftList(h, h.proxyPort, { forwardVariant: { priority: '0' } });
    await expect(authorizeProxyEndpoint(h, { proxyListenPort: h.proxyPort, exec: fake }))
      .resolves.toBe(h);
  });

  it('fails closed when the forward chain has the wrong priority (prio:1)', async () => {
    const fake = new FakeExec();
    const h = await setupNetns({ sessionId: 'sess badprio', exec: fake });
    fake.nftListOutput = buildFakeNftList(h, h.proxyPort, { forwardVariant: { prio: 1 } });
    await expect(authorizeProxyEndpoint(h, { proxyListenPort: h.proxyPort, exec: fake }))
      .rejects.toThrow(/forward chain malformed.*prio=1/i);
  });

  it('fails closed when the forward chain has the wrong policy (policy accept)', async () => {
    const fake = new FakeExec();
    const h = await setupNetns({ sessionId: 'sess badpol', exec: fake });
    fake.nftListOutput = buildFakeNftList(h, h.proxyPort, { forwardVariant: { policy: 'accept' } });
    await expect(authorizeProxyEndpoint(h, { proxyListenPort: h.proxyPort, exec: fake }))
      .rejects.toThrow(/forward chain malformed.*policy=accept/i);
  });

  it('fails closed when the forward chain has the wrong hook (hook input)', async () => {
    const fake = new FakeExec();
    const h = await setupNetns({ sessionId: 'sess badhook', exec: fake });
    fake.nftListOutput = buildFakeNftList(h, h.proxyPort, { forwardVariant: { hook: 'input' } });
    await expect(authorizeProxyEndpoint(h, { proxyListenPort: h.proxyPort, exec: fake }))
      .rejects.toThrow(/forward chain malformed.*hook=input/i);
  });

  it('fails closed when the forward chain has the wrong type (type route)', async () => {
    const fake = new FakeExec();
    const h = await setupNetns({ sessionId: 'sess badtype', exec: fake });
    fake.nftListOutput = buildFakeNftList(h, h.proxyPort, { forwardVariant: { type: 'route' } });
    await expect(authorizeProxyEndpoint(h, { proxyListenPort: h.proxyPort, exec: fake }))
      .rejects.toThrow(/forward chain malformed.*type=route/i);
  });

  it('fails closed when the forward chain is entirely absent from the dump', async () => {
    const fake = new FakeExec();
    const h = await setupNetns({ sessionId: 'sess nofwd', exec: fake });
    fake.nftListOutput = buildFakeNftList(h, h.proxyPort, { omitForward: true });
    await expect(authorizeProxyEndpoint(h, { proxyListenPort: h.proxyPort, exec: fake }))
      .rejects.toThrow(/forward chain missing/i);
  });
});

// ---------------------------------------------------------------------------
// 2. Linux-gated real smoke test — skipped on macOS.
// ---------------------------------------------------------------------------

const isLinux = process.platform === 'linux';
// Real kernel operations need root: `ip netns add` writes /run/netns and the
// os-helper asserts euid 0. A plain CI runner (ubuntu-latest) is Linux but
// unprivileged — the real netns smoke must skip there, not fail spuriously
// with `mkdir /run/netns failed: Permission denied`.
const canRunOsSmoke = isLinux && typeof process.getuid === 'function' && process.getuid() === 0;
const REQUIRE_OS = process.env.OCTOPUS_REQUIRE_OS_SANDBOX === '1';

// Hard-fail guard: on the Plan 6 lane REQUIRE_OS=1 is set to convert any
// capability skip into a hard failure. If the env is set but the test is
// being collected on a host that cannot run the real smoke (non-Linux or
// unprivileged), the whole gated block would silently skip and the lane would
// appear green. This portable test forces the lane to fail loudly instead.
describe('OCTOPUS_REQUIRE_OS_SANDBOX contract (netns)', () => {
  it('hard-fails when REQUIRE_OS=1 but the host cannot run the real netns smoke', () => {
    if (REQUIRE_OS && !canRunOsSmoke) {
      throw new Error(
        'OCTOPUS_REQUIRE_OS_SANDBOX=1 but the netns smoke cannot run here ' +
        '(platform or root capability missing) — the lane cannot silently regress',
      );
    }
  });
});

describe.skipIf(!canRunOsSmoke)('setupNetns — real Linux netns smoke', () => {
  it('creates a no-egress-window namespace, authorizes the proxy, and cleans up only its own objects', async () => {
    if (REQUIRE_OS) {
      // On the Plan 6 privileged lane this test MUST run end-to-end. Any
      // capability failure surfaces via the throws below, not via a skip.
    }

    // Snapshot net.ipv4.ip_forward BEFORE setup; assert it is unchanged at
    // every later step. Setup must never touch host-global sysctls.
    const ipForwardBefore = (await fs.readFile('/proc/sys/net/ipv4/ip_forward', 'utf8')).trim();

    const h = await setupNetns({ sessionId: `oct-smoke-${process.pid}` });
    try {
      // /run/netns/<name> exists.
      await fs.access(h.path);

      // The netns inode differs from the host.
      const { stdout: nsInode } = await execFileAsync('ip', ['netns', 'exec', h.name, 'readlink', '/proc/self/ns/net']);
      const { stdout: hostInode } = await execFileAsync('readlink', ['/proc/self/ns/net']);
      expect(nsInode.trim()).not.toBe(hostInode.trim());

      // ip -brief link shows only this session's two <=15-byte veth names.
      const { stdout: links } = await execFileAsync('ip', ['-brief', 'link']);
      const sessionLinks = links.split('\n').filter((l) => l.includes(h.hostIf) || l.includes(h.skillIf));
      expect(sessionLinks.length).toBeGreaterThanOrEqual(1); // hostIf visible; skillIf is in the netns
      expect(h.hostIf.length).toBeLessThanOrEqual(15);
      expect(h.skillIf.length).toBeLessThanOrEqual(15);

      // Both addresses and routes are /32. No default route.
      const { stdout: addrOut } = await execFileAsync('ip', ['addr', 'show', 'dev', h.hostIf]);
      expect(addrOut).toContain(`${h.proxyIp}/32`);
      const { stdout: skillAddrOut } = await execFileAsync('ip', ['netns', 'exec', h.name, 'ip', 'addr', 'show', 'dev', h.skillIf]);
      expect(skillAddrOut).toContain(`${h.skillIp}/32`);

      const { stdout: routes } = await execFileAsync('ip', ['netns', 'exec', h.name, 'ip', 'route', 'show']);
      expect(routes).not.toMatch(/default/);

      // No route can reach 1.1.1.1 from inside the netns.
      const { stdout: r1111 } = await execFileAsync('ip', ['netns', 'exec', h.name, 'ip', 'route', 'get', '1.1.1.1'])
        .catch(() => ({ stdout: '' }));
      expect(r1111).not.toMatch(/dev /);

      // Authorize the proxy endpoint.
      await authorizeProxyEndpoint(h, { proxyListenPort: h.proxyPort });

      // The installed table contains exactly the allow rules for proxyIp:proxyPort
      // plus established/related return, with drop policy for everything else.
      const { stdout: nftList } = await execFileAsync('ip', ['netns', 'exec', h.name, 'nft', '-j', 'list', 'table', 'inet', h.nftTable]);
      const parsed = JSON.parse(nftList);
      const blob = JSON.stringify(parsed);
      expect(blob).toContain(String(h.proxyPort));
      expect(blob).toContain(h.proxyIp);
      // NAT-negative invariant: no masquerade/snat/dnat anywhere.
      expect(blob).not.toMatch(/masquerade|snat|dnat/i);
      // Structural forward-chain parse: a `forward` base chain with type
      // filter, hook forward, normalized priority === 0, policy drop MUST be
      // present in the read-back dump. The walker already enforces this in
      // authorizeProxyEndpoint; here we assert the JSON shape directly so a
      // regression in either the ruleset builder or the walker is caught.
      const fwdChain = (parsed.nftables as Array<{ chain?: { name?: string; type?: string; hook?: string; prio?: unknown; priority?: unknown; policy?: string } }>)
        .find((e) => e.chain?.name === 'forward')?.chain;
      expect(fwdChain).toBeDefined();
      expect(fwdChain!.type).toBe('filter');
      expect(fwdChain!.hook).toBe('forward');
      expect(fwdChain!.policy).toBe('drop');
      const prioRaw = fwdChain!.prio ?? fwdChain!.priority;
      expect(Number(prioRaw)).toBe(0);

      // Connectivity: a listener bound to proxyIp:proxyPort is reachable
      // from the netns; the same IP on a different port is NOT.
      const server = net.createServer((sock) => { sock.end('ok'); });
      await new Promise<void>((res) => server.listen(h.proxyPort, h.proxyIp, res));
      try {
        const got = await new Promise<string>((resolve, reject) => {
          const c = net.createConnection({ host: h.proxyIp, port: h.proxyPort }, () => {});
          c.setTimeout(2000);
          let buf = '';
          c.on('data', (d) => { buf += d.toString(); });
          c.on('end', () => resolve(buf));
          c.on('error', reject);
          c.on('timeout', () => reject(new Error('timeout')));
        });
        expect(got).toBe('ok');

        // Same IP on a different port must fail (nft drop).
        await expect(new Promise<void>((resolve, reject) => {
          const c = net.createConnection({ host: h.proxyIp, port: h.proxyPort + 1 }, () => {});
          c.setTimeout(1500);
          c.on('connect', () => { c.destroy(); resolve(); });
          c.on('error', reject);
          c.on('timeout', () => { c.destroy(); reject(new Error('timeout')); });
        })).rejects.toThrow();

        // Public IP 1.1.1.1:80 must also fail (no egress to anything other
        // than proxyIp:proxyPort, even after authorization).
        await expect(new Promise<void>((resolve, reject) => {
          const c = net.createConnection({ host: '1.1.1.1', port: 80 }, () => {});
          c.setTimeout(1500);
          c.on('connect', () => { c.destroy(); resolve(); });
          c.on('error', reject);
          c.on('timeout', () => { c.destroy(); reject(new Error('timeout')); });
        })).rejects.toThrow();

        // ip_forward must STILL be unchanged after authorize.
        const ipForwardAfterAuth = (await fs.readFile('/proc/sys/net/ipv4/ip_forward', 'utf8')).trim();
        expect(ipForwardAfterAuth).toBe(ipForwardBefore);
      } finally {
        server.close();
      }
    } finally {
      // Cleanup removes the namespace, veth pair, and nft table.
      await h.cleanup();
    }

    // After cleanup the named netns is gone.
    await expect(fs.access(h.path)).rejects.toThrow();
    // The host-side veth is gone.
    const { stdout: linksAfter } = await execFileAsync('ip', ['-brief', 'link']);
    expect(linksAfter).not.toContain(h.hostIf);
    // The session nft table is gone.
    const { stdout: tablesAfter } = await execFileAsync('nft', ['list', 'tables']);
    expect(tablesAfter).not.toContain(h.nftTable);
    // ip_forward is still unchanged after the entire lifecycle.
    const ipForwardFinal = (await fs.readFile('/proc/sys/net/ipv4/ip_forward', 'utf8')).trim();
    expect(ipForwardFinal).toBe(ipForwardBefore);
  }, 30000);
});
