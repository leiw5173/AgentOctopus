'use strict';
/* octopus-boot — route built-in Node fetch (undici) through the egress proxy.
 *
 * Loaded via NODE_OPTIONS=--require /opt/octopus-boot/bootstrap.cjs inside the
 * distroless runtime image. Built-in fetch in Node v22 does NOT honor
 * HTTP(S)_PROXY, and `node:undici`/`setGlobalDispatcher` from a vendored copy
 * do NOT affect the built-in dispatcher. The only reliable hook is assigning a
 * vendored undici ProxyAgent directly to the shared global dispatcher Symbol.
 *
 * Fail-loud to stderr but NEVER throw: a broken bootstrap must not crash the
 * skill. The failure mode stays fail-closed (guest DNS is cut → EAI_AGAIN), it
 * never opens a direct path to the internet. */
try {
  const proxy = process.env.HTTPS_PROXY || process.env.HTTP_PROXY;
  if (!proxy) {
    // No proxy env → leave the default dispatcher untouched (unchanged behavior).
    return;
  }

  const path = require('node:path');
  const { ProxyAgent } = require(path.join(__dirname, 'undici', 'index.js'));

  // Prime the global dispatcher so Node populates the shared slot before we
  // overwrite it. Use a data: URL so no network is touched. The assignment is
  // synchronous so the first real fetch can never race a half-installed
  // dispatcher.
  const KEY = Symbol.for('undici.globalDispatcher.1');
  globalThis[KEY] = new ProxyAgent(proxy);

  // Best-effort priming after installation; any failure is non-fatal.
  (async () => {
    try { await fetch('data:,'); } catch { /* ignore */ }
  })();
} catch (err) {
  process.stderr.write(`[octopus-boot] bootstrap error: ${(err && err.message) || err}\n`);
}
