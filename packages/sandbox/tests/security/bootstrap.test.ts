import { describe, it, expect } from 'vitest';
import { spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';

const HERE = dirname(fileURLToPath(import.meta.url));
const BOOTSTRAP = join(HERE, '..', '..', 'images', 'runtime', 'bootstrap.cjs');

// The vendored undici 6.24.1 ProxyAgent implements the undici v6 dispatcher
// interface (Node 22 runtime image). Other Node majors (e.g. v26 -> undici v8)
// reject it, so the routing assertion only runs on the authoritative Node 22.
const NODE_MAJOR = Number(process.versions.node.split('.')[0]);
const onImageNode = NODE_MAJOR === 22;

// Run a Node child that --require's the bootstrap then fetches, with the proxy
// env pointed at an unroutable address. If the bootstrap works, built-in fetch
// is routed through the (dead) proxy → ECONNREFUSED. If the bootstrap is absent
// or broken, the fetch attempts a direct connection to a made-up host and the
// guest DNS cut yields EAI_AGAIN. We assert the bootstrap changes the failure
// mode from EAI_AGAIN to ECONNREFUSED — proof fetch is now proxy-routed.
function fetchWithBootstrap(env: NodeJS.ProcessEnv): string {
  const script = `
    (async () => {
      try { await fetch('http://nonexistent-oct-e2e.invalid/'); console.log('NOERROR'); }
      catch (e) { console.log(String(e.cause?.code ?? e.code ?? e.message)); }
    })();
  `;
  const r = spawnSync(process.execPath, ['--require', BOOTSTRAP, '-e', script], {
    env: { PATH: process.env.PATH, ...env },
    encoding: 'utf8',
  });
  return (r.stdout || '') + (r.stderr || '');
}

describe.skipIf(!onImageNode)('bootstrap.cjs proxy routing', () => {
  it('is a no-op when no proxy env is set (behavior unchanged)', () => {
    const out = fetchWithBootstrap({});
    // No proxy env → bootstrap returns early → fetch does a direct DNS lookup of
    // the .invalid host → EAI_AGAIN (or ENOTFOUND on hosts that resolve it).
    expect(out).toMatch(/EAI_AGAIN|ENOTFOUND/);
    expect(out).not.toContain('[octopus-boot] error');
  });

  it('routes built-in fetch through the proxy when HTTPS_PROXY is set', () => {
    const out = fetchWithBootstrap({ HTTPS_PROXY: 'http://127.0.0.1:1' });
    // Proxy is set but unroutable → fetch now reaches the proxy layer and fails
    // with ECONNREFUSED, NOT the direct-DNS EAI_AGAIN. This is the fixed behavior.
    expect(out).toContain('ECONNREFUSED');
    expect(out).not.toMatch(/EAI_AGAIN|ENOTFOUND/);
  });
});
