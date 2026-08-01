---
'@agentoctopus/sandbox-vm-native': patch
---

fix(sandbox-vm-native): provision libclang for the libkrun macOS source build

libkrun's `krun-input` crate build script uses clang-sys (bindgen) and links
`@rpath/libclang.dylib`. Xcode's clang does not ship a dyld-visible
`libclang.dylib` (only `clang.dylib` inside Xcode.app, off the search path), so
the macOS vm-lane build aborted with `dyld: Library not loaded:
@rpath/libclang.dylib` (SIGABRT in the krun-input build script).

`vendor-libkrun.mjs` now resolves a real libclang directory (Homebrew's keg-only
`llvm`, or an explicit `LIBCLANG_PATH`) and exports `LIBCLANG_PATH` +
`DYLD_FALLBACK_LIBRARY_PATH` to the make subprocess so clang-sys can both link
and dlopen the dylib. No-op on non-darwin platforms and when no libclang is
installed (clang-sys falls back to its own search and surfaces the actionable
"install llvm" error).

Also: the post-build `linkSmokeTest` RUN step now sets `DYLD_LIBRARY_PATH`
(Darwin) / `LD_LIBRARY_PATH` (Linux) — mirroring `engine.ts`/`run-vm-gates.mjs` —
instead of always `LD_LIBRARY_PATH`, which Darwin ignores. Without it the smoke
binary linked fine but could not locate `libkrun.1.dylib` in the target dir at
runtime.

And `linkVersionedSonames` no longer skips Darwin: libkrun's Makefile bakes
`-install_name libkrun.1.dylib` (and our `libkrunfw.5.dylib` is compiled
`-DABI_VERSION=5`), so the VERSIONED filename is the loader-resolved name there
too. It now reads the real install_name via `otool -D` (falling back to the pinned
`libkrun.1.dylib`/`libkrunfw.5.dylib`) and creates the versioned symlink — still
a symlink to the single digest-verified real file, never a second unverified copy
(a TCB gap).
