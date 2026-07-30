---
"@agentoctopus/sandbox-vm-native": patch
---

Fix `mass_close_fds()` fallback loops to close fds up to the real `RLIMIT_NOFILE` ceiling instead of a hard-coded 4096. Adds `fd_ceiling()` helper with `FD_LOW_WATERMARK` floor, unsigned `rlim_t` comparison, and defensive `FD_CEILING_MAX` cap. Includes a wired C regression test.
