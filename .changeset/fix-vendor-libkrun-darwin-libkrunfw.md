---
'@agentoctopus/sandbox-vm-native': patch
---

fix(sandbox-vm-native): build libkrunfw.dylib on darwin from the kernel bundle

The darwin-arm64 VM lane failed vendoring libkrunfw: `vendor-libkrun.mjs`
searched the `libkrunfw-prebuilt-aarch64.tgz` tarball for a `libkrunfw.dylib`
that does not exist. **No** prebuilt darwin dylib exists anywhere in the
libkrunfw v5.5.0 line — all three release assets (prebuilt-aarch64, aarch64,
x86_64) ship ELF `.so` or the kernel source. The prebuilt-aarch64 tarball
ships the GENERATED `kernel.c` bundle (the aarch64 Linux kernel already
compiled + serialized by `bin2cbundle.py`), not a library.

On darwin, compile that bundle into `libkrunfw.5.dylib` natively — exactly
libkrunfw's own Makefile final Darwin step (`cc -fPIC -DABI_VERSION=5 -shared
-o libkrunfw.5.dylib kernel.c`) — then symlink `libkrunfw.dylib ->
libkrunfw.5.dylib` (its `install` layout). This skips `build_on_krunvm.sh`
(which would boot a nested VM to rebuild the kernel) because the bundle already
contains the built kernel. Linux keeps extracting the prebuilt versioned `.so`.

Verified on darwin/arm64: the 93MB `kernel.c` compiles to a valid arm64 Mach-O
dylib in <1s; it exports `krunfw_get_kernel`/`krunfw_get_version`; a probe
links against `-lkrunfw` through the `libkrunfw.dylib` symlink and runs. The
manifest digest hashes the real versioned file (readstream follows the
symlink), and the versioned-SONAME shim still early-returns on darwin so no
bogus `.so.5` link is created.
