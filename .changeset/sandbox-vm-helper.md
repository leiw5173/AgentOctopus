---
"@agentoctopus/sandbox-vm-native": minor
---

feat(sandbox-vm-native): sandbox-vm-helper C subprocess with pinned libkrun v1.19.4 start sequence — mass_close_fds (Linux close_range + fallback, Darwin closefrom), base64url JSON launch-spec parser (fail-closed strict scanner), fixed control FDs 3/4 via krun_add_console_port_inout, 13-step TSI-disable sequence, ad-hoc codesign with hypervisor entitlements on Darwin. Compile-only smoke path until libkrun dylibs vendored (Task 15).
