---
"@agentoctopus/sandbox-vm-native": patch
---

Publish @agentoctopus/sandbox-vm-native as part of the release (F1).

The native VM package was declared as core's optionalDependency but never added
to the release pipeline — release-preflight packed 7 tarballs (no
sandbox-vm-native), release-publish had no publish step for it, and its version
sat at 0.1.0 while the rest of the workspace was at 0.8.0. An npm user
installing @agentoctopus/core could never obtain the VM backend (the optional
dep was unsatisfiable).

Add sandbox-vm-native to release-preflight's PACKAGES list (after sandbox,
which it depends on) and a publish step to release-publish immediately after
the sandbox publish. Align the version to 0.8.0 and confirm it is in the
changeset fixed group so future releases bump it in lockstep. The published
tarball includes dist/ + prebuilds/.
