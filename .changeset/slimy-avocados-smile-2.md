---
"@agentoctopus/sandbox-vm-native": minor
---

Add VmEngineImpl with posix_spawn FD plumbing (R9/R10) and createCloexecPipe seam. VmEngineImpl.start() builds the two-cloexec-pipe FD config, F_DUPFD_CLOEXEC temp slots, and adddup2 into fd3/fd4 (source≠target real dup2), with a ready-handshake protocol on the g2hRead control stream and failure paths for error-frame / helper-exit-before-ready / timeout.
