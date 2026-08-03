---
"@agentoctopus/sandbox": patch
---

fix(sandbox): resolve the VM-lane native package from the leaf test

The VM L3/L4 lane skipped all 16 tests on the physical Apple Silicon
runner even after G1/G2 went green and the release manifest signed.
`buildLaneVmEngine()` returned null: it located
`@agentoctopus/sandbox-vm-native` via a bare
`createRequire(import.meta.url).resolve(...)` / `import(...)` from the
leaf `sandbox` package — but sandbox does not depend on the native
package (only `core` does) and pnpm does not hoist it, so the resolution
failed `MODULE_NOT_FOUND`. The skip gate then fail-closed the lane with
zero diagnostics.

Resolve the native package as the SIBLING workspace package anchored at
the test file's own path (`fileURLToPath(import.meta.url)` →
`../../../sandbox-vm-native`), and import the built engine from its
`dist/index.js` by absolute file URL. Probe now actually runs; on a dev
box it stops only at the (locally absent) gate manifest, and on the
qualified lane it proceeds against the produced gate + signed release
manifest.
