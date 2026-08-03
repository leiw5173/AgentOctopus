---
"@agentoctopus/sandbox-vm-native": patch
---

fix(sandbox-vm-native): restrict VM helper subprocess environment to a minimal allowlist (HI-1). Stop leaking host secrets (e.g. GITHUB_TOKEN, HOME) by replacing `{ ...process.env }` with only PATH, the four OCTOPUS_VM_* / OCTOPUS_VSOCK_* control variables, and the platform-specific libkrun library path (DYLD_LIBRARY_PATH on Darwin, LD_LIBRARY_PATH on Linux) only when already set.
