---
"@agentoctopus/sandbox": patch
---

Fix output cap memory bound (F5) and IPv6 loopback rejection (F6).

F5: `collectBounded*Result` in the vm/docker/os backends pushed each chunk
BEFORE checking the combined stdout+stderr cap and kept pushing after overflow
was set, so a flooding process could push the captured buffer far past
`outputMaxBytes` before the kill landed. The cap is now checked first, the
offending chunk is trimmed to the exact remaining budget, and further chunks
are dropped once overflow fires — the captured buffer never exceeds the cap.

F6: Node's `URL.hostname` preserves IPv6 brackets
(`new URL('http://[::1]:8').hostname === "[::1]"`), so the VM backend's loopback
set lookup rejected the explicitly-allowed `::1` egress-proxy target, and
`normalizeHost` left brackets in place for every policy-engine caller. A new
`stripIpv6Brackets` helper strips them before the loopback check and at the top
of `normalizeHost`, so `::1` is a valid loopback target everywhere.
