---
"@agentoctopus/core": patch
---

Make the F4 vm-assembly test robust to locally-built (gitignored) VM prebuilds.

`createVmBackend`'s F4 test asserted the backend always returns `{unavailable}`
when no explicit `helperPath` is configured — the prebuilds dir was assumed
empty on a clean checkout. A locally-built (gitignored) `sandbox-vm-helper` +
`vm-image-builder` in `prebuilds/darwin-arm64/` (e.g. produced while debugging
the VM lane on a dev machine) flips that to a full backend, failing the
assertion. The test now accepts either outcome:

- `{unavailable}` (fresh checkout) — the reason must still echo a path under
  `sandbox-vm-native/prebuilds/<platform>` (package-graph resolution), never
  the broken `node_modules/packages/sandbox-vm-native` source-tree walk;
- a `kind: 'vm'` backend (locally-built prebuilds) — the resolution itself
  proves the package graph worked, since the broken walk would always resolve
  to a nonexistent path and thus return unavailable.

This is test-only; no runtime behavior change. (It also un-gates `pnpm test`
on dev machines that have built VM prebuilds locally.)
