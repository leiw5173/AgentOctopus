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
    expect(nft).not.toMatch(/masquerade|snat|dnat|hook forward/i);
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
    expect(s).not.toMatch(/masquerade|snat|dnat|hook forward/i);
    // No forward chain in initial rules.
    expect(p.initialNftRules.join('\n')).not.toMatch(/chain forward/i);
    expect(p.authorizeProxyRules(43210).join('\n')).not.toMatch(/chain forward/i);
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
    // No forward / nat chain.
    expect(init).not.toMatch(/type filter hook forward/i);
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
  });
});

describe('authorizeProxyEndpoint (injected fake exec)', () => {
  it('atomically replaces the table and verifies the exact port rule via read-back', async () => {
    const fake = new FakeExec();
    const h = await setupNetns({ sessionId: 'sess auth', exec: fake });
    const port = h.proxyPort;
    // Provide the nft -j list output the read-back expects.
    fake.nftListOutput = JSON.stringify({
      nftables: [
        { table: { family: 'inet', name: h.nftTable } },
        { rule: { chain: 'output', expr: [{ match: { left: { payload: { field: 'daddr' } }, right: h.proxyIp } }, { match: { left: { payload: { field: 'dport' } }, right: port } }, { accept: null }] } },
        { rule: { chain: 'input', expr: [{ match: { left: { payload: { field: 'saddr' } }, right: h.proxyIp } }, { match: { left: { payload: { field: 'sport' } }, right: port } }, { accept: null }] } },
      ],
    });
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
    // No forward/nat anywhere.
    expect(replaceCall!.stdin).not.toMatch(/masquerade|snat|dnat|hook forward/i);
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
});

// ---------------------------------------------------------------------------
// 2. Linux-gated real smoke test — skipped on macOS.
// ---------------------------------------------------------------------------

const isLinux = process.platform === 'linux';
const REQUIRE_OS = process.env.OCTOPUS_REQUIRE_OS_SANDBOX === '1';

describe.skipIf(!isLinux)('setupNetns — real Linux netns smoke', () => {
  it('creates a no-egress-window namespace, authorizes the proxy, and cleans up only its own objects', async () => {
    if (REQUIRE_OS) {
      // On the Plan 6 privileged lane this test MUST run end-to-end.
    }

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
      expect(blob).not.toMatch(/masquerade|snat|dnat|hook forward/i);

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
  }, 30000);
});
