---
'@agentoctopus/sandbox-vm-native': patch
---

fix(sandbox-vm-native): locate versioned libkrunfw.so in the prebuilt tarball

`vendor-libkrun.mjs`'s `extractLibkrunfwPrebuilt` searched the extracted
libkrunfw prebuilt tarball with `find -type f -name libkrunfw.so` (exact name,
regular files only). The linux-x64 prebuilt (`libkrunfw-x86_64.tgz`) ships the
standard versioned layout — `lib64/libkrunfw.so -> .so.5 -> .so.5.5.0`, where
the only REGULAR file is `libkrunfw.so.5.5.0` and the unversioned name is a
symlink — so the exact `-type f` match found nothing and the producer died with
`libkrunfw prebuilt libkrunfw.so not found`, failing `produce-linux-artifacts`
and cascading-skip the `privileged-linux` lane. The darwin prebuilt ships a
plain `libkrunfw.dylib` regular file, so only the linux-x64 lane was affected.

The lookup now tries the exact name first (darwin), then a versioned glob
(`<libName>*`, matching `libkrunfw.so.5.5.0` on linux). Trust is unchanged:
`downloadVerified()` still SHA-256-verifies the whole tarball against the pin
before extraction; this only locates the already-verified payload within it.
