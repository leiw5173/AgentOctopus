---
"@agentoctopus/sandbox": patch
---

linux-topology lane: fix two test-harness teardown bugs that the prior hermetic/veth fixes exposed.

- **Proxy-traversal test hang (180s timeout):** the fixture's loopback upstream
  was closed in `finally` with `server.close()`, which waits for EVERY accepted
  connection to end and has NO timeout. The egress proxy's connection to the
  upstream can linger (half-closed) after the round-trip, so `close()` blocked
  forever and the test ran to its full 180s timeout — masking the credential
  round-trip. The fixture now tracks every accepted connection and destroys
  them explicitly before `close()` (with a 2s `close()` ceiling as
  belt-and-suspenders). This is version-independent: `server.closeAllConnections()`
  is not available on the runner's Node, so an explicit tracked-socket destroy
  is used instead. This was the ONLY unbounded operation in the test path
  (setup, `backend.run()`, `cgroup.waitEmpty`, and `sandbox.cleanup()` are all
  deadline-bounded; the companion teardown test proves `cleanup()` does not
  hang).
- **Teardown test re-bind assertion (EADDRNOTAVAIL):** the final step re-bound
  `proxyIp:proxyPort` to prove the proxy listener closed. That is incompatible
  with correct teardown: `proxyIp` lives on the host veth, which teardown
  deletes (and the test asserts is gone), so the address no longer exists and a
  bind fails EADDRNOTAVAIL rather than reading the EADDRINUSE-vs-closed signal.
  Replaced with `hostSsListenCount(proxyIp, proxyPort) === 0` — the host `ss`
  table shows no listener on the proxy address (the kernel destroyed the socket
  bound to the deleted veth), which is consistent with full teardown.
