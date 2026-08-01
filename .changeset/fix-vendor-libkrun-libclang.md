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
