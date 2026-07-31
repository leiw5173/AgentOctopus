---
'@agentoctopus/sandbox-vm-native': patch
---

fix(sandbox-vm-native): emit the runtime rootfs placement (rootfs/<ref>)

build-vm-rootfs.mjs now copies the sealed rootfs image to
`prebuilds/<arch>/rootfs/<ref>` in addition to the top-level `rootfs.img`.
`engine.resolveRootfs()` resolves `rootfsDir/<ref>` at launch time, but the
producer previously wrote only the top-level image consumed by
run-vm-gates.mjs — so a VM launch could not locate the rootfs without
workflow-side copying. Every producer (all CI lanes, local builds) now emits
both placements with the 0444 seal preserved on the runtime copy.
