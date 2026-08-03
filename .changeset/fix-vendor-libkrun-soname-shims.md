---
'@agentoctopus/sandbox-vm-native': patch
---

fix(sandbox-vm-native): create versioned-SONAME shims for the vendored libs

libkrun's Makefile bakes a versioned `DT_SONAME` into the built library
(`libkrun.so.1` for the v1.19.4 pin), and the libkrunfw prebuilt ships SONAME
`libkrunfw.so.5`. vendor-libkrun copies each lib into prebuilds under its
unversioned link-time name (`libkrun.so` / `libkrunfw.so`). Linking
`-lkrun -lkrunfw` resolves those unversioned files, but the linker records
`DT_NEEDED=<SONAME>` and the runtime loader resolves that by FILENAME — so the
vendored libs linked but failed to LOAD, dying with
`error while loading shared libraries: libkrun.so.1: cannot open shared object
file` at the produce-linux-artifacts link smoke test (and, later, for the
vm-helper at runtime).

Create the versioned names as SYMLINKS to the unversioned lib, derived from the
lib's real SONAME via `readelf -d` (falling back to the pinned sonames if
readelf is absent). A symlink — not a second real copy — keeps exactly one
digest-verified real file per lib: the loader follows the shim to the verified
bytes, whereas a real copy would be loaded by the OS with no digest check (a
TCB gap). The fail-closed path removes the shims alongside the libs. No-op on
Darwin, whose dylibs use an unversioned install_name.
