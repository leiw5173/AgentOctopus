---
"@agentoctopus/sandbox": minor
"@agentoctopus/core": patch
"@agentoctopus/adapters": patch
---

Add the release-blocking sandbox security matrix and immutable runtime supply chain. The runtime image has no entrypoint or shell/network clients and executes direct argv; the egress-proxy image is self-contained. Docker, privileged Linux, proxy, persistent MCP, identity/snapshot, and macOS restricted/fail-closed lanes now prove host-canary isolation, proxy-only egress, credential scoping, redirect/framing/smuggling/DNS/TLS defenses, resource and process-tree cleanup, and digest sensitivity. Release preflight and publish require successful security results for the exact release SHA and immutable image digests.

Co-Authored-By: Claude Sonnet 4.6 <noreply@anthropic.com>
