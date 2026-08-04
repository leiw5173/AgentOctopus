# @agentoctopus/sandbox-vm-native

## 0.9.0

### Minor Changes

- 82c1482: feat(sandbox-vm-native): native VmEngineDeps binding + production constructor wiring (CR-5)

  - Added `koffi`-based `createNativeDeps()` FFI binding in `packages/sandbox-vm-native/src/native-binding.ts`.
  - Implements `pipe()` (Linux `pipe2(O_CLOEXEC)` / Darwin `pipe()+__fcntl(F_SETFD,FD_CLOEXEC)`), `dupFdCloexec()` (`F_DUPFD_CLOEXEC`), and `spawn()` (`posix_spawn` + file actions + Darwin `POSIX_SPAWN_CLOEXEC_DEFAULT`).
  - `spawn()` creates real stdout/stderr pipes with `adddup2` file actions; controlRead/stdin are overridden by the engine with fd-backed streams (Approach A) via `__octopusNeedsEngineOverride` sentinel marker.
  - `waitpid` ECHILD (rc<0) treated as child-already-reaped (resolve, not reject).
  - NUL-byte rejection in argv/envp (koffi silently truncates at NUL).
  - Wires `createVmBackend()` to construct `VmEngineImpl(engineOpts, createNativeDeps())` and `VmImageBuilderImpl(builderBinaryPath)`.
  - Extends `sandbox.vm` schema with optional artifact-path fields defaulting to `prebuilds/<platform>/`.
  - Fail-closed existence check on helperPath/builderBinaryPath in assembly.

  Co-Authored-By: Claude Sonnet 4.6 <noreply@anthropic.com>

- 000a440: Add a lightweight VM sandbox backend (libkrun v1.19.4 + Hypervisor.framework)
  for `full` isolation without Docker Desktop dependency. Skills run inside a
  Linux VM with the snapshot exposed as a read-only ext4 block image (NOT
  virtiofs — libkrun treats guest and VMM as the same host security context),
  built by a deterministic cross-platform image-builder (no system mkfs.ext4 /
  Docker / Homebrew dependency for skill block images; the rootfs uses standard
  `mke2fs` since it must carry a real ~30 MiB node binary that exceeds the C
  writer's single-block-group capacity) with descriptor-relative traversal
  (openat + fstat on the fd, O_NOFOLLOW, explicit "."/".." rejection — no
  lstat→open swap race) and a TOCTOU-closing digest re-compute. The
  image-builder port exposes two methods: buildSnapshotImage (directory +
  canonical snapshot digest) and buildSingleFileImage (single file + file
  digest, for the CA bundle).

  libkrun runs in a dedicated signed+entitled helper subprocess
  (krun_start_enter terminates its caller) using the real v1.19.4 API
  (krun_set_vm_config(ctx, num_vcpus, ram_mib) — vCPUs before RAM, per the
  verified header signature + krun_disable_implicit_vsock +
  krun_add_vsock(tsi_features=0) + krun_add_vsock_port + krun_add_disk for
  block ids vda/vdb/vdc + krun_set_root_disk_remount("/dev/vda","ext4","ro")

  - krun_set_exec of a TRUSTED bootstrap /usr/libexec/octopus-vm-init +
    krun_set_workdir(ctx, "/") — workdir pinned to "/", NOT the workload cwd,
    because /skill is not mounted until the bootstrap runs). The trusted
    bootstrap (PID 1) mounts /dev/vdb→/skill and /dev/vdc→/etc/skill-ca
    read-only, mounts tmpfs /tmp + /run, starts the loopback↔vsock forwarder,
    emits a ready handshake, then execve's the original workload.

  The workload executable/argv/env travel as a base64url(canonical-CBOR)
  LaunchSpec blob in bootstrapArgv[1] (single channel — raw CBOR cannot ride
  argv since argv is NUL-terminated; not a block artifact, not over the
  control channel); dual size caps (decoded 65536 / argv token 98304)
  enforced before start; NUL bytes rejected in every string; malformed spec
  ⇒ bootstrap exits 127 without execve (fail-closed). The control channel
  is a named virtio-console port ("octopus-control") registered via
  krun_add_virtio_console_multiport + krun_add_console_port_inout (NOT an
  inherited host fd — host fds do not cross the VMM boundary); it carries
  ONLY ready/error frames (NO exit frame — once execve replaces PID 1 no
  bootstrap process remains); workload exit status is the helper subprocess
  exit status caused by krun_start_enter (function only returns on pre-start
  error; otherwise exit()s the helper with the guest exit code).

  Implicit TSI is explicitly disabled (and BLK feature verified) so the sole
  network egress is a vsock-bridged in-process egress proxy (credentials
  never enter the VM). The leaf-package boundary is closed by defining
  VmEnginePort + VmImageBuilderPort in packages/sandbox and injecting both
  via DI; packages/sandbox imports nothing from the native package — not
  even `import type`. probe() is parameterless (verifies TCB artifacts + BLK

  - hypervisor + gate-manifest signature + outer release manifest); the
    selected rootfs is qualified in prepare() via resolveRootfs +
    assertRootfsQualified.

  Two qualification gates (host-file-unreachable, network-canary-unreachable)
  run at CI/release time and bind a (platform × artifact-digest) gate
  manifest — including imageBuilder + qualifiedRootfsDigests[] +
  manifestDigest (self-hash over body excluding the digest field) — signed
  by an outer release manifest (Ed25519, compiled-in public key). Runtime
  probe verifies the manifest+signature; prepare asserts the selected rootfs
  is qualified before claiming `full`. libkrun v1.19.4 is built from pinned
  source (the upstream release ships no binary assets); libkrunfw v5.5.0
  uses the upstream prebuilt tarballs. L3 (7) + L4 (9) escape-matrix tests
  are skipIf-gated on `OCTOPUS_VM_LANE=1` + `probe()` and run on the `vm-lane`
  CI job in `sandbox-security.yml`. Available on macOS Apple Silicon; Linux
  x64 requires a privileged /dev/kvm CI lane or is marked unsupported
  (fail-closed).

- 70664d1: feat(sandbox-vm-native): sandbox-vm-helper C subprocess with pinned libkrun v1.19.4 start sequence — mass_close_fds (Linux close_range + fallback, Darwin closefrom), base64url JSON launch-spec parser (fail-closed strict scanner), fixed control FDs 3/4 via krun_add_console_port_inout, 13-step TSI-disable sequence, ad-hoc codesign with hypervisor entitlements on Darwin. Compile-only smoke path until libkrun dylibs vendored (Task 15).
- 2ca2c44: Create the sandbox-vm-native package with assertExecutablesQualified: R9/R10 executable-qualification logic (cheap uncached keys==bins set-equality check + cached rootfs stat-walk enforcing regular-file + exec-bit + no-symlink + not-under-mount-override).
- Add VmEngineImpl with posix_spawn FD plumbing (R9/R10) and createCloexecPipe seam. VmEngineImpl.start() builds the two-cloexec-pipe FD config, F_DUPFD_CLOEXEC temp slots, and adddup2 into fd3/fd4 (source≠target real dup2), with a ready-handshake protocol on the g2hRead control stream and failure paths for error-frame / helper-exit-before-ready / timeout.

  Add the VM TCB producer scripts: `build-vm-rootfs.mjs` builds the sealed read-only ext4 guest rootfs with standard `mke2fs` (e2fsprogs) — fixed UUID/timestamps/inode params, journal + lazy-init disabled, double-build SHA-256 reproducibility assertion — producing `prebuilds/linux-arm64/rootfs.img` and `prebuilds/linux-x64/rootfs.img`. `vendor-libkrun.mjs` vendors libkrun v1.19.4 (built from pinned source, since the upstream release ships no binary assets) and libkrunfw v5.5.0 (upstream prebuilt tarballs, checksum-verified), writes per-artifact TCB manifests, and runs a link + runtime smoke test. Adds `security:build-vm` and `security:probe-vm` package scripts.

  Add `run-vm-gates.mjs` (G1 host-file-unreachable + G2 network-canary-unreachable qualification gates; emits `gate-manifest.json` with `qualifiedRootfsDigests[]` from both arch rootfs manifests, artifact refs from per-artifact manifests, and `manifestDigest` via `computeManifestDigest`) and `sign-release-manifest.mjs` (Ed25519 detached signature over canonical gate-manifest JSON; private key from CI secret `OCTOPUS_VM_RELEASE_PRIVATE_KEY`, `--bootstrap` for first-run keypair generation, `--print-public` to derive the public key constant for `release-key.ts`; self-verifies before writing `outer-release-manifest.json`).

- 1359376: Add VmEngineImpl with posix_spawn FD plumbing (R9/R10) and createCloexecPipe seam. VmEngineImpl.start() builds the two-cloexec-pipe FD config, F_DUPFD_CLOEXEC temp slots, and adddup2 into fd3/fd4 (source≠target real dup2), with a ready-handshake protocol on the g2hRead control stream and failure paths for error-frame / helper-exit-before-ready / timeout.

  Add the VM TCB producer scripts: `build-vm-rootfs.mjs` builds the sealed read-only ext4 guest rootfs with standard `mke2fs` (e2fsprogs) — fixed UUID/timestamps/inode params, journal + lazy-init disabled, double-build SHA-256 reproducibility assertion — producing `prebuilds/linux-arm64/rootfs.img` and `prebuilds/linux-x64/rootfs.img`. `vendor-libkrun.mjs` vendors libkrun v1.19.4 (built from pinned source, since the upstream release ships no binary assets) and libkrunfw v5.5.0 (upstream prebuilt tarballs, checksum-verified), writes per-artifact TCB manifests, and runs a link + runtime smoke test. Adds `security:build-vm` and `security:probe-vm` package scripts.

  Add `run-vm-gates.mjs` (G1 host-file-unreachable + G2 network-canary-unreachable qualification gates; emits `gate-manifest.json` with `qualifiedRootfsDigests[]` from both arch rootfs manifests, artifact refs from per-artifact manifests, and `manifestDigest` via `computeManifestDigest`) and `sign-release-manifest.mjs` (Ed25519 detached signature over canonical gate-manifest JSON; private key from CI secret `OCTOPUS_VM_RELEASE_PRIVATE_KEY`, `--bootstrap` for first-run keypair generation, `--print-public` to derive the public key constant for `release-key.ts`; self-verifies before writing `outer-release-manifest.json`).

### Patch Changes

- 1926c03: Publish @agentoctopus/sandbox-vm-native as part of the release (F1).

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

- c42c0b3: Fix release-manifest signature producer↔verifier mismatch (F3).

  The producer wrote one enveloped `outer-release-manifest.json`
  (`{ manifest, signature, signedBy, signedAt }`) but the verifier read two
  files and verified the signature over the FIRST file's bytes — feeding the
  envelope as `releaseManifestPath` verified the signature over the envelope
  JSON (which includes signature/signedAt), not the inner body, so verification
  always failed. The assembly also set no default paths, so production never
  wired the verifier at all.

  Switch to a detached-signature scheme matching the verifier's contract: the
  signer writes `release-manifest.json` (raw canonical gate-manifest body — the
  exact bytes the signature covers) + `release-manifest.json.sig` (base64
  Ed25519), keeping the enveloped bundle as a human-readable artifact only. The
  assembly defaults both paths to `prebuilds/<platform>/`. Engine `probe()` now
  treats a PRESENT manifest with `no-key` (empty trust root placeholder) as
  fail-closed `signature-invalid` rather than soft `missing` — a present-but-
  unverifiable signature is not a capability probe, so the bootstrap fails loud
  on any real release until `RELEASE_PUBLIC_KEY_BASE64` is committed. Absent
  manifest files still soft-fall to `missing` (dev box).

- 4430808: Fix a false-negative `codesign` availability probe in `build-vm-helper.mjs`. The Darwin ad-hoc signing path probed the tool with `codesign --version`, but Apple's `codesign` does not accept a `--version` flag — it exits with code 2 ("unrecognized option") even though the binary exists and is on PATH. `execFileAsync` rejects on any non-zero exit, so the `try/catch` misreported a present `codesign` as "not on PATH … install Xcode command line tools" and died before signing (observed on the macOS vm-lane). The probe now treats only an `ENOENT` spawn failure as "not on PATH" and proceeds on any other exit code, letting the real signing call surface an actual `codesign` error if one exists.
- f1f18d6: fix(sandbox-vm-native): make build-vm-rootfs produce deterministic ext4 images

  Several latent bugs surfaced the first time the VM rootfs build ran on the
  release lane (the VM TCB chain had never built before, so these never
  executed). The headline fix is true byte-reproducibility; earlier attempts
  only pinned SOME timestamps, so the double-build assertion flaked.

  1. **Tool gate misprobed tune2fs.** It ran `tune2fs -V` to check presence, but
     tune2fs has no -V flag (exit 1); execFile rejects on ANY non-zero exit, so
     an INSTALLED tune2fs was misreported as "not on PATH". Probe by resolving
     the tool on PATH instead — uniform across mke2fs/debugfs/cc.

  2. **Inode exhaustion.** `inodeCount = entries + 4` ignored that ext4 reserves
     inodes 1-10 (root=2) and mke2fs takes inode 11 for lost+found, so the tree's
     inodes start at 12 — leaving only `entries - 6` usable. It died with "Could
     not allocate inode" once a real guest node binary was packed. Now
     `entries + 32`.

  3. **Byte-level nondeterminism (the real fix).** The double-build reproducibility
     assertion kept diverging because earlier fixes only pinned a subset of
     timestamps. The complete mechanism, verified on ext4/relatime with a real
     124MB node binary:

     - `E2FSPROGS_FAKE_TIME=1` (not `0` — 0 is falsy/unset) fakes the
       mkfs-assigned times: superblock created/last-check and inode crtime.
     - `mke2fs -E hash_seed=<uuid>` pins the 16-byte s_hash_seed.
     - The staging tree's atime+mtime are pinned to the epoch (`pinStagingTimes`)
       so mke2fs `-d` copies stable atime/mtime into each inode.
     - **Drop tune2fs entirely**: it unconditionally re-bumps the superblock
       `s_wtime` to the wall clock even under E2FSPROGS_FAKE_TIME, and mke2fs
       already sets mount count 0 + the pinned UUID — so tune2fs was pure
       nondeterminism.
     - **debugfs-zap every inode's ctime**: ctime is the inode-metadata-change
       time — mke2fs always sets it to the wall clock and no `touch` can pin it.
       Sweep `set_inode_field <N> ctime <epoch>` over all inodes post-build.

     Verified: two (and three) builds produce byte-identical SHA-256 images with
     a clean superblock (UUID pinned, mount count 0, wtime=epoch1).

- c27d9a1: fix(sandbox-vm-native): build libkrun with the blk feature (BLK=1)

  vm-helper.c calls `krun_add_disk` and `krun_set_root_disk_remount` — libkrun's
  block-device ABI, exported ONLY when libkrun is built with the `blk` cargo
  feature. The vendored build ran a plain `make` (no feature flags), and `blk` is
  NOT a default feature, so the produced libkrun.so omitted those symbols and the
  build-vm-helper link failed:
  `undefined reference to 'krun_add_disk'` / `'krun_set_root_disk_remount'`.

  libkrun's Makefile maps `BLK=1` → `--features blk` (`ifeq ($(BLK),1)`). Pass it
  so the TCB carries the ABI the engine requires (`blkFeatureRequired`). virtio-blk
  is pure Rust, so no extra system libraries are needed. The other 12 krun\_\*
  symbols vm-helper uses (vsock/console/exec/config) resolve in the default build,
  so blk is the only feature flag required.

- 0ecce14: fix(sandbox-vm-native): correct the libkrun source tarball SHA pin

  The pinned SHA-256 for the libkrun v1.19.4 source tarball did not match the
  actual codeload tarball for commit `728df812` (the download succeeded but the
  checksum mismatched), so `vendor-libkrun` died before building libkrun —
  failing `produce-linux-artifacts`. Re-verified the real digest against a
  deterministic double download (`a0dfa34a…`). This is a trust-root correction
  (user-reviewed): the pin is a trust anchor, and GitHub codeload tarballs are
  generated on demand, so their byte-level digest can drift over time. A more
  robust anchor (content-hash of the extracted tree rather than the tarball
  bytes) is a worthwhile follow-up.

- 016598f: Fix the Darwin `libkrunfw` layout so the TCB digest path is a real file, not a symlink. `buildLibkrunfwDylibFromBundle` previously compiled `libkrunfw.5.dylib` (real) and made `libkrunfw.dylib` a symlink to it, but `verifyVmTcb` hard-rejects a symlink at the digest path (`libkrunfw.dylib`), so `build-vm-helper.mjs` died with `verifyVmTcb rejected the combined manifest: libkrunfw: not a regular file (symlink/missing)` on the macOS vm-lane. The function now compiles under the versioned name and renames the real bytes to the unversioned link-time name `libkrunfw.dylib` (atomic same-dir rename, exactly one digest-verified real copy); `linkVersionedSonames` then provides `libkrunfw.5.dylib` as a symlink to that real file, matching the libkrun layout and the single-real-file TCB invariant. Because the dylib is compiled with no `-install_name` flag, its recorded install_name stays exactly `libkrunfw.5.dylib` after the rename, so `-lkrunfw` consumers still resolve at runtime (verified: consumer links, records `DT_NEEDED=libkrunfw.5.dylib`, and runs via the versioned symlink).
- e0c99e6: Fix `private-tcb-loader.test.ts` failing with `available:false` on the Linux CI lane. The test mocked `GateManifestSchema.parse` / `verifyGateManifest` but never wrote `gate-manifest.json` to disk; `VmEngineImpl.probe()` `readFile()`s the gate manifest from the filesystem before passing the parsed body to the (mocked) schema, so the probe died with `ENOENT → available:false, gateManifest:'missing'`. The test now writes the constructed gate body to `gate-manifest.json` so the probe's disk read succeeds. Verified passing in a Linux container with a real C toolchain.
- 29ed328: Fix a circular SONAME symlink in `vendor-libkrun.mjs` `linkVersionedSonames`. On Darwin the libkrunfw layout is `libkrunfw.5.dylib` (real file) + `libkrunfw.dylib → libkrunfw.5.dylib` (symlink). `linkVersionedSonames` received the `libkrunfw.dylib` symlink, resolved its install_name to `libkrunfw.5.dylib`, then `rm`'d the real versioned file and symlinked `libkrunfw.5.dylib → libkrunfw.dylib` — producing `libkrunfw.5.dylib ↔ libkrunfw.dylib`, a cycle that destroyed the real bytes and broke `-lkrunfw` at link time (`ld: library 'krunfw' not found` on the macOS vm-lane). The function now skips a lib whose symlink target already IS the resolved versioned name (the shim relationship is already correct), leaving the digest-verified real file intact.
- 420285a: fix(sandbox-vm-native): build libkrunfw.dylib on darwin from the kernel bundle

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

- 3f54a3c: fix(sandbox-vm-native): provision libclang for the libkrun macOS source build

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

- 7f1e7bd: fix(sandbox-vm-native): locate versioned libkrunfw.so in the prebuilt tarball

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

- 91fd795: fix(sandbox-vm-native): return the full manifest from writeArtifactManifest

  `writeArtifactManifest` returned a flat `{sha256,size,mode}` record, but its
  callers log `fwManifest.artifact.sha256` / `krunManifest.artifact.size`,
  expecting the nested manifest shape — so vendoring crashed with
  `Cannot read properties of undefined (reading 'sha256')` immediately after the
  libkrunfw extraction succeeded. Return the full manifest object (which carries
  `.artifact`), matching the callers and `build-vm-rootfs.mjs`'s existing
  `return manifest` convention.

- fd1218a: fix(sandbox-vm-native): create versioned-SONAME shims for the vendored libs

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

- 22059b3: Wire the VM gate's helper spawn through the engine's fd plumbing so G1/G2 capture the guest console.

  `run-vm-gates.mjs` booted the qualification VM with a plain `execFile`, leaving the helper's required control fds (3 = host→guest, 4 = guest→host console, 5 = rootfs `/dev/fd/5`) as inherited handles to `/dev/null`. The helper booted, relayed the guest probe's `G1-DONE`/`G2-DONE` console output to a dead fd, opened the wrong rootfs inode, and exited 0 with empty captured stdout — a NO-GO "helper early-exit, no output" that looked like a dyld/codesign kill but was actually the gate reading the wrong channel.

  The gate now spawns via `createNativeDeps().spawn` with the same file_actions the engine installs (dup2 temp→3/4/5), reads the guest console from fd 4, and falls back to the helper's own stdout/stderr + exit status when the console stays empty. `native-binding.ts` exports `fdToReadable`/`fdToWritable` for this (not added to the leaf public surface in `index.ts`).

- 347e7f2: Fix a FileHandle lifecycle bug in run-vm-gates.mjs that aborted the G1 gate on the first real physical-runner VM boot. `openRootfsReadOnly` returned only the raw fd from `fs.open()`, dropping the FileHandle; modern Node treats a GC-collected FileHandle as an error and closed fd 17 (rootfs.img) out from under the parent's independent raw-fd management ("A FileHandle object was closed during garbage collection"). The function now returns the FileHandle, the caller owns it, and both cleanup paths close it explicitly via a new `closeHandle`. The bug was latent until vm-lane ran on bare-metal Apple Silicon — on hosted macos-15 the lane always skipped before reaching G1.
- e8bd1ad: Drop the unnecessary `com.apple.vm.networking` entitlement from the Darwin helper's ad-hoc codesign — it made the kernel SIGKILL the helper at exec.

  The VM helper runs the guest with vsock-ONLY networking (TSI disabled — `vm-helper.c` adds no virtio-net/passt/gvproxy), so it needs only `com.apple.security.hypervisor`. Requesting `com.apple.vm.networking` (bridged/vmnet networking the helper never uses) on an ad-hoc signature causes macOS 15+ (verified on macOS 26 and the `macos-15` lane) to SIGKILL the process at exec with exit 137 and zero userspace output — the exact G1/G2 and `--has-blk` kill observed on the vm-lane. Signing with only the hypervisor entitlement runs cleanly.

- fix(sandbox-vm-native): define \_GNU_SOURCE so vm-image-builder.c compiles under -std=c11

  build-vm-helper compiles vm-image-builder.c with `-std=c11 -Wall -Wextra
-Werror`. Strict ISO C11 (`__STRICT_ANSI__`) hides the descriptor-relative
  syscalls and flags the writer depends on — openat/fdopendir/fchmod plus
  O_CLOEXEC/O_NOFOLLOW/F_DUPFD_CLOEXEC (POSIX.1-2008) and O_DIRECTORY (a GNU
  extension) — so the produce-linux-artifacts compile failed with "implicit
  declaration" / "undeclared" errors. This is a latent bug: the VM TCB chain had
  never built before, so the file had never been compiled.

  Define `_GNU_SOURCE` before the includes: it overrides the strict-ISO hiding
  (and implies POSIX.1-2008 + \_ATFILE_SOURCE), exposing every symbol the file
  uses. Also correct the header comment that falsely claimed "pure portable POSIX
  ... builds on macOS AND Linux" (O_DIRECTORY is Linux/GNU-only). Verified:
  compiles clean with the exact CI flags on Ubuntu (gcc, glibc).

- 9653779: fix(sandbox-vm-native): define \_GNU_SOURCE so vm-image-builder.c compiles under -std=c11

  build-vm-helper compiles vm-image-builder.c with `-std=c11 -Wall -Wextra
-Werror`. Strict ISO C11 (`__STRICT_ANSI__`) hides the descriptor-relative
  syscalls and flags the writer depends on — openat/fdopendir/fchmod plus
  O_CLOEXEC/O_NOFOLLOW/F_DUPFD_CLOEXEC (POSIX.1-2008) and O_DIRECTORY (a GNU
  extension) — so the produce-linux-artifacts compile failed with "implicit
  declaration" / "undeclared" errors. This is a latent bug: the VM TCB chain had
  never built before, so the file had never been compiled.

  Define `_GNU_SOURCE` before the includes: it overrides the strict-ISO hiding
  (and implies POSIX.1-2008 + \_ATFILE_SOURCE), exposing every symbol the file
  uses. Also correct the header comment that falsely claimed "pure portable POSIX
  ... builds on macOS AND Linux" (O_DIRECTORY is Linux/GNU-only). Verified:
  compiles clean with the exact CI flags on Ubuntu (gcc, glibc).

- 4600774: Fix `mass_close_fds()` fallback loops to close fds up to the real `RLIMIT_NOFILE` ceiling instead of a hard-coded 4096. Adds `fd_ceiling()` helper with `FD_LOW_WATERMARK` floor, unsigned `rlim_t` comparison, and defensive `FD_CEILING_MAX` cap. Includes a wired C regression test.
- fda4ede: Fail-closed VM backend hardening (HI-4/HI-5/LO-1):

  - `waitForReady` now kills the handshake after more than two malformed non-JSON control frames instead of silently dropping them.
  - `probe()` no longer hard-codes `blkFeature: 'present'`; it invokes the helper's new `--has-blk` subcommand to check `KRUN_FEATURE_BLK` at runtime and fails closed if BLK support is absent or unprobeable.
  - `resolveRootfs()` now streams the rootfs through `createReadStream` + `createHash` instead of reading the entire image into memory before hashing.

- 1a91212: fix(sandbox-vm-native): restrict VM helper subprocess environment to a minimal allowlist (HI-1). Stop leaking host secrets (e.g. GITHUB*TOKEN, HOME) by replacing `{ ...process.env }` with only PATH, the four OCTOPUS_VM*_ / OCTOPUS*VSOCK*_ control variables, and the platform-specific libkrun library path (DYLD_LIBRARY_PATH on Darwin, LD_LIBRARY_PATH on Linux) only when already set.
- fix(sandbox-vm-native): real statRootfsFile via ro loopback mount (HI-2)

  - Added `packages/sandbox-vm-native/src/rootfs-loopback-mount.ts` implementing the real `statRootfsFile` seam for `assertExecutablesQualified`.
  - `createLoopbackStatRootfsFile()` mounts the sealed ext4 rootfs image read-only at a per-call temp mountpoint (`mount -o loop,ro`; needs CAP_SYS_ADMIN — privileged-Linux CI lane), stats the guest path, then umounts + cleans up.
  - `mountRootfsReadOnly(path)` + `umount(handle)` exported for reuse.
  - Fail-closed invariant: mount/stat/umount failures THROW a descriptive `RootfsMountError` — never silently degrade to "all executables qualified". ENOENT (guest path absent) is the only condition returning null (caller rejects via `ExecutablesUnqualifiedError`).
  - Resource safety: umount + rmdir run in try/finally around stat; a second try/finally around umount ensures temp-dir cleanup even on umount failure.
  - Non-Linux platforms throw fail-closed (loopback mount unavailable); the production VM backend `prepare()` path runs only where CAP_SYS_ADMIN is available.
  - Wired the real factory into `VmEngineImpl.assertExecutablesQualified` (engine.ts), replacing the previous always-null stub.
  - New Linux-lane tests (skipIf-gated to Linux + mke2fs) build a tiny ext4 fixture and assert pass/fail of `assertExecutablesQualified` against the real loopback mount. Existing injectable-seam unit tests unchanged.

  Co-Authored-By: Claude Sonnet 4.6 <noreply@anthropic.com>

- a511ddf: fix(sandbox-vm-native): real statRootfsFile via ro loopback mount (HI-2)

  - Added `packages/sandbox-vm-native/src/rootfs-loopback-mount.ts` implementing the real `statRootfsFile` seam for `assertExecutablesQualified`.
  - `createLoopbackStatRootfsFile()` mounts the sealed ext4 rootfs image read-only at a per-call temp mountpoint (`mount -o loop,ro`; needs CAP_SYS_ADMIN — privileged-Linux CI lane), stats the guest path, then umounts + cleans up.
  - `mountRootfsReadOnly(path)` + `umount(handle)` exported for reuse.
  - Fail-closed invariant: mount/stat/umount failures THROW a descriptive `RootfsMountError` — never silently degrade to "all executables qualified". ENOENT (guest path absent) is the only condition returning null (caller rejects via `ExecutablesUnqualifiedError`).
  - Resource safety: umount + rmdir run in try/finally around stat; a second try/finally around umount ensures temp-dir cleanup even on umount failure.
  - Non-Linux platforms throw fail-closed (loopback mount unavailable); the production VM backend `prepare()` path runs only where CAP_SYS_ADMIN is available.
  - Wired the real factory into `VmEngineImpl.assertExecutablesQualified` (engine.ts), replacing the previous always-null stub.
  - New Linux-lane tests (skipIf-gated to Linux + mke2fs) build a tiny ext4 fixture and assert pass/fail of `assertExecutablesQualified` against the real loopback mount. Existing injectable-seam unit tests unchanged.

  Co-Authored-By: Claude Sonnet 4.6 <noreply@anthropic.com>

- 44297c0: Fail-closed VM release-signature verification and compiled-in trust root.

  - `RELEASE_PUBLIC_KEY_BASE64` is now a placeholder constant in `packages/sandbox/src/vm/release-key.ts`; the real Ed25519 public key must be committed before the first production release that exercises VM release signing.
  - The test seam `OCTOPUS_VM_RELEASE_KEY_TEST` is renamed/exposed as `RELEASE_PUBLIC_KEY_TEST_SEAM` and is explicitly NOT the production source.
  - `verifyOuterReleaseManifest` returns a discriminated result (`no-key` | `bad-signature` | `ok`) so callers can distinguish an unsigned dev build from an invalid production signature.
  - `VmEngineImpl.probe()` now fails closed (`available: false`, `releaseManifest: 'signature-invalid'`) when both manifest and signature files are present but the signature is invalid; absent files still probe as `missing` with `available: true`.

- 1cf3c5f: fix(sandbox-vm-native): build helper launch spec as helper argv[1] (CR-1/CR-2)

  The VM helper's argv[1] must be a base64url(JSON) helper launch spec containing rootfsPath, skillBlockPath, caBlockPath, vsockPort, vsockHostSocket, cpus, memMib, bootstrapPath, bootstrapArgv, and trustedEnv. The guest bootstrapArgv (including the CBOR blob) is nested inside this spec. Previously the engine passed the guest bootstrapArgv directly as the helper's argv, which broke the helper contract and prevented the VM from booting.

  - Added `buildHelperLaunchSpec()` in `packages/sandbox-vm-native/src/helper-launch-spec.ts` with fail-closed validation (absolute paths, no `..`, no NUL, vsockPort range, bootstrapArgv length/exactly bootstrapPath).
  - Wired it into `VmEngineImpl.start()` so the helper is spawned with `[helperPath, helperSpecToken]`.
  - Added optional `trustedEnv?: string[]` to `VmStartConfig` in `packages/sandbox/src/vm/types.ts` for Task 2's vsock environment plumbing.
  - Updated L1 fake-spawn tests to assert the new helper argv contract and decode/verify the nested spec.

- fix(sandbox-vm-native): unified vm-tcb-manifest with imageBuilder (HI-3)

  - `packages/sandbox-vm-native/scripts/build-vm-helper.mjs` now builds the
    `vm-image-builder` TCB artifact (from `src/vm-image-builder.c`) and writes
    its per-artifact manifest, then aggregates helper/libkrun/libkrunfw/imageBuilder
    into ONE combined `prebuilds/<platform>/vm-tcb-manifest.json` with each entry
    `{sha256, size, mode}`.
  - `packages/sandbox-vm-native/scripts/run-vm-gates.mjs` reads artifact refs from
    the combined `vm-tcb-manifest.json` instead of four separate per-artifact files.
  - New shared helper `packages/sandbox-vm-native/scripts/tcb-manifest.mjs` exports
    `buildTcbManifest()` (producer), `readArtifactRefsFromTcbManifest()` (gate),
    and `readPerArtifactEntry()`.
  - Fail-closed invariant: if the imageBuilder artifact or its per-artifact manifest
    is absent/malformed, `buildTcbManifest()` throws and writes no combined manifest.
    If the combined manifest is missing or malformed, `readArtifactRefsFromTcbManifest()`
    throws. `verifyVmTcb` rejection during the build self-check is now fatal.
  - `packages/core/src/sandbox-vm-assembly.ts` defaults `tcbManifestPath` to
    `prebuilds/<platform>/vm-tcb-manifest.json` to match the unified manifest.

  Co-Authored-By: Claude Sonnet 4.6 <noreply@anthropic.com>

- 97a3585: fix(sandbox-vm-native): unified vm-tcb-manifest with imageBuilder (HI-3)

  - `packages/sandbox-vm-native/scripts/build-vm-helper.mjs` now builds the
    `vm-image-builder` TCB artifact (from `src/vm-image-builder.c`) and writes
    its per-artifact manifest, then aggregates helper/libkrun/libkrunfw/imageBuilder
    into ONE combined `prebuilds/<platform>/vm-tcb-manifest.json` with each entry
    `{sha256, size, mode}`.
  - `packages/sandbox-vm-native/scripts/run-vm-gates.mjs` reads artifact refs from
    the combined `vm-tcb-manifest.json` instead of four separate per-artifact files.
  - New shared helper `packages/sandbox-vm-native/scripts/tcb-manifest.mjs` exports
    `buildTcbManifest()` (producer), `readArtifactRefsFromTcbManifest()` (gate),
    and `readPerArtifactEntry()`.
  - Fail-closed invariant: if the imageBuilder artifact or its per-artifact manifest
    is absent/malformed, `buildTcbManifest()` throws and writes no combined manifest.
    If the combined manifest is missing or malformed, `readArtifactRefsFromTcbManifest()`
    throws. `verifyVmTcb` rejection during the build self-check is now fatal.
  - `packages/core/src/sandbox-vm-assembly.ts` defaults `tcbManifestPath` to
    `prebuilds/<platform>/vm-tcb-manifest.json` to match the unified manifest.

  Co-Authored-By: Claude Sonnet 4.6 <noreply@anthropic.com>

- 91a69bd: fix(sandbox-vm-native): close the runtime gaps in the verified-object binding

  - BLK probe now executes the PRIVATE verified helper copy: probe() creates
    the engine-private copies (hash-as-copied from a single O_NOFOLLOW fd)
    BEFORE the capability probe and runs it with LD/DYLD_LIBRARY_PATH pointed
    at the private dir — the original path is never executed, so a
    realpath→exec swap cannot smuggle unverified code. Any probe failure after
    the copies are made discards the private dir.
  - Versioned SONAME shims (libkrun.so.1 → libkrun.so, libkrunfw.so.5 →
    libkrunfw.so) are recreated inside the private 0700 dir pointing at the
    verified copies: the helper's DT_NEEDED uses versioned names, so without
    them the Linux loader misses the libs — or falls back to unverified
    same-named system libraries. Covered by a real ELF loader test
    (Linux+cc-gated), not just env-string assertions.
  - The C helper's launch mode preserves the inherited rootfs fd 5 across its
    startup mass-close (watermark raised to 6; the --has-blk probe mode still
    closes everything ≥ 5) and fcntl(F_GETFD)-checks fd 5 before
    krun_add_disk("/dev/fd/5") would otherwise get a dead path.

- 7256c9c: fix(sandbox-vm-native): drop duplicate bootstrapPath from bootstrapArgv (libkrun argv[0] semantics)

  The VM guest died at bootstrap with `launch-spec decode/validate failed` on
  every real boot. Root cause (confirmed by an in-guest diagnostic): libkrun's
  `krun_set_exec(exec_path, argv, ...)` uses `exec_path` as the guest's argv[0]
  and **appends** the supplied `argv` array after it. The old
  `bootstrapArgv = [bootstrapPath, launchSpecBlob]` therefore produced guest
  `argv = [path, path, blob]`, so vm-init read the executable _path_ (not the
  CBOR blob) at argv[1] and failed to decode it. `bootstrapArgv` now carries
  only the blob (`[launchSpecBlob]`), yielding guest `argv = [path, blob]` with
  the blob at argv[1] as the bootstrap protocol expects. Validation invariants
  in engine.ts, helper-launch-spec.ts, and vm-helper.c updated from
  "length 2 / argv[0]===bootstrapPath" to "length 1 / argv[0]!==bootstrapPath".

  The G1/G2 qualification-gate launch specs also moved `cwd` from `/tmp` to
  `/skill`: vm-init's R7 constraint requires the workload cwd to realpath()
  under the read-only `/skill` block-image mount, so a `/tmp` cwd was rejected
  with `cwd not under /skill` even after the argv fix.

- fix(sandbox-vm-native): recreate Darwin versioned dylib shims in the private TCB dir

  The vm-lane BLK feature probe failed on the physical Apple Silicon runner
  with `dyld: Library not loaded: libkrun.1.dylib`, so `probe()` returned
  `available:false` and all 16 L3/L4 tests skipped (fail-closed).

  `verifyVmTcb` resolves the realpath of each TCB artifact before
  `copyVerifiedArtifact` copies it into the engine-private dir — so the
  private libkrun/libkrunfw copies carry the UNVERSIONED basenames
  (`libkrun.dylib`). But the helper's dyld install name is the VERSIONED
  `libkrun.1.dylib` (a symlink → `libkrun.dylib` in the artifacts dir).
  `mirrorSonameLinks`, which recreates those versioned shims pointing at the
  verified private copies, only matched the Linux `.so.N` pattern and was an
  explicit no-op on Darwin — so the private dir never got `libkrun.1.dylib`
  and the loader could not resolve the helper's dependency from the verified
  copies.

  Extend the shim pattern to the Darwin `.N.dylib` names
  (`libkrun.1.dylib`, `libkrunfw.5.dylib`), still targeting only the private
  copy's basename. Adds a platform-agnostic regression test pinning both the
  Linux `.so.N` and Darwin `.N.dylib` mirroring (the existing loader test is
  ELF/Linux-only and skips on macOS — the gap that let this through).

- 6cc93cd: fix(sandbox-vm-native): recreate Darwin versioned dylib shims in the private TCB dir

  The vm-lane BLK feature probe failed on the physical Apple Silicon runner
  with `dyld: Library not loaded: libkrun.1.dylib`, so `probe()` returned
  `available:false` and all 16 L3/L4 tests skipped (fail-closed).

  `verifyVmTcb` resolves the realpath of each TCB artifact before
  `copyVerifiedArtifact` copies it into the engine-private dir — so the
  private libkrun/libkrunfw copies carry the UNVERSIONED basenames
  (`libkrun.dylib`). But the helper's dyld install name is the VERSIONED
  `libkrun.1.dylib` (a symlink → `libkrun.dylib` in the artifacts dir).
  `mirrorSonameLinks`, which recreates those versioned shims pointing at the
  verified private copies, only matched the Linux `.so.N` pattern and was an
  explicit no-op on Darwin — so the private dir never got `libkrun.1.dylib`
  and the loader could not resolve the helper's dependency from the verified
  copies.

  Extend the shim pattern to the Darwin `.N.dylib` names
  (`libkrun.1.dylib`, `libkrunfw.5.dylib`), still targeting only the private
  copy's basename. Adds a platform-agnostic regression test pinning both the
  Linux `.so.N` and Darwin `.N.dylib` mirroring (the existing loader test is
  ELF/Linux-only and skips on macOS — the gap that let this through).

- 2cee58e: feat(sandbox-vm-native): darwin ext4 stat reader for executable qualification

  The darwin-arm64 vm-lane failed all 16 L3/L4 tests at `prepare()` with
  `RootfsMountError: loopback rootfs mount is only available on Linux (got
darwin)`. `assertExecutablesQualified` — the fail-closed check that every
  `vmRuntime.executables` value is a regular, non-symlink, exec-bit file inside
  the verified rootfs — had only ONE stat seam: the Linux CAP_SYS_ADMIN loopback
  mount. macOS cannot mount ext4, and no darwin stat mechanism existed (the
  design assumed this stat-walk would only ever run on the privileged-Linux
  lane).

  Add a self-contained ext4 READER: a `stat`/`statfd` mode on the
  `vm-image-builder` C tool that parses the mke2fs-produced rootfs directly (no
  mount, no external binary). It implements superblock/group-descriptor/inode
  parse, an extent-tree walk, and a linear directory walk — sufficient for the
  small, shallow guest tree (no htree is ever instantiated). It fails closed
  (non-zero exit → throw) on anything unexpected: an indirect-block inode, a
  hash-indexed directory, a bad extent magic, or a malformed/truncated image.
  Symlinks are detected from `i_mode` WITHOUT being followed (mirrors the
  loopback `statInMount` lstat-primary rule).

  The engine pins the verified rootfs inode to an open fd in the parent; the
  darwin seam reads via that fd by INHERITANCE (`statfd <fd>`), because a child
  cannot open the parent's `/dev/fd/<N>` path (it resolves against the child's
  own fd table → "Bad file descriptor"). The TS `createExt4StatRootfsFile()` seam
  dup2's the pinned fd into the child's stdio slot 3 via spawn's `{ fd }` option
  and invokes `statfd 3` — `execFile` does NOT inherit extra fds, so spawn is
  used and manages stdout/stderr/exit/timeout itself. `engine.assertExecutablesQualified`
  selects the ext4 reader on darwin (Linux keeps the loopback mount unchanged).
  Covered by a byte-exact synthetic ext4 fixture (mke2fs is unavailable on the
  dev box) exercising the full verdict matrix + the three fail-closed rejections.

- ee72c55: fix(sandbox-vm-native): import 32-byte Ed25519 seed via PKCS8 DER wrap

  `deriveEd25519FromSeed` built an OKP JWK carrying only `d` (no `x`), which
  Node rejects with `ERR_CRYPTO_INVALID_JWK` ("Invalid JWK OKP key") — so a CI
  secret stored as the documented base64 32-byte seed could never sign a
  release manifest. The seed is now wrapped in a PKCS8 DER structure
  (RFC 5208: `SEQUENCE { version, AlgorithmIdentifier(id-Ed25519),
OCTET STRING { OCTET STRING { seed } } }`), byte-identical to a canonical
  PKCS8 export. PKCS8 PEM/DER secret forms are unaffected. Regression-tested
  by spawning `--print-public` for both forms of the same keypair.

- ad77636: Cross-compile the guest binaries (`octopus-vm-init`, `octopus-vsock-forwarder`) statically for the correct target arch. They were built with the host `cc`, so on the x64 producer they became x86-64 dynamically-linked binaries regardless of target arch — the linux-arm64 guest kernel cannot exec them ("Couldn't execute '/usr/libexec/octopus-vm-init' inside the vm: No such file or directory": wrong ISA, and the sealed rootfs has no dynamic loader). `arch` is now threaded through buildArch → buildStaging → compileGuest, selecting `aarch64-linux-gnu-gcc` for arm64 and host `cc` for x64, always with `-static`. Changes the rootfs tree, so the producer emits a new sealed digest on the next build. Latent until vm-lane ran on physical Apple Silicon — the x64 guest's vm-init was correct by accident.
- eadf18d: Fix two VM-lane guest-boot blockers in the native VM backend.

  - **`engine.ts` `waitForReady` frame parser**: control frames from vm-init are NOT newline-delimited — they are written back-to-back on the octopus-control port (e.g. `{"ready":true}{"exit":0}` arrives as a single chunk). The previous reader split on `'\n'`, never fired on the buffered ready frame, sat until EOF, then mis-reported a healthy boot as "helper closed control channel before ready (EOF)". Replaced with a brace-matching `drainFrames` that extracts each complete top-level JSON object, counts leading/embedded non-JSON garbage against the malformed-frame bound (HI-4, fail-closed), and buffers truncated trailing objects for the next chunk (flushed on EOF). Also captures the helper's early stderr (bounded, 4 KiB) so a start failure carries the helper's own diagnostics instead of a bare EOF.

  - **`vm-image-builder.c` ext4 direct-block addressing**: the writer emits legacy direct-block inodes (`i_flags=0`) but set ONLY `i_block[0]`. Any file larger than one 1024-byte block had no direct pointer for blocks 1..N-1, so the guest kernel read them as holes (NUL bytes) and the file appeared truncated + zero-padded (probe.js → guest SyntaxError past block 1). Directory inodes had `i_block[0]=0`, so `/skill` listed empty. The writer now records each allocated block's physical number per file (`block_map[12]`, blocks need not be contiguous since directory and file data blocks are interleaved) and fills every direct pointer; the single-file (CA) path fills its contiguous run likewise. Adds a regression test that builds a real `snapshot` image with a >1-block file and asserts every direct-block pointer is non-zero and the bytes read back intact (verified to fail on the pre-fix binary).

- 79c9b8f: Fix the four vm-lane L3/L4 failures surfaced now that the lane runs for real (G1/G2 GO, probe verified, manifest signed). 12/16 already passed; these close the remaining gaps.

  - **Guest env credential containment (fail-closed).** `buildGuestEnv` previously merged the _entire_ untrusted `spec.env` into the guest (`{...specEnv}`), so any host credential the caller held leaked into the VM — the L4 credential-leak escape vector. It now installs only an explicit SAFE allowlist of probe-orchestration var names (`PROBE_ACTION`, `PROBE_HOST`, `PROBE_PORT`, `HOST_CANARY_PATH`) and drops everything else, then forces the trusted proxy/CA overrides. This matches the OS sandbox's existing contract (its helper clears the env and installs only a SAFE allowlist). Unit tests updated to assert stripping + allowlist passthrough.

  - **vm-init exit-frame delivery (allowlist ⇒ exit 127).** Two coordinated fixes. (a) The post-ready `die()`/`die_errno()` paths wrote `{"error":…}{"exit":127}` then `_exit(127)` with **no settle delay** — unlike the workload path, which `usleep(50ms)`s before exiting. init.krun reboots the guest the moment it reaps PID 1, so the queued virtio-console tx was dropped by the device reset. (b) In the host engine, the exit-frame capture attached to the control stream **after** the ready handshake resolved — but `waitForReady` detaches its own `onData` on the ready frame, so a fast rejection writing `{"ready":true}{"error":…}{"exit":127}` in a SINGLE chunk had its exit frame dropped at the listener boundary. The capture now attaches **before** the handshake and stays attached post-ready, so the authoritative guest exit code is never missed. Together these ensure a rejected exec surfaces as `exitCode 127`, never the helper's always-0 fallback. `vm-init.c` is compiled into the guest rootfs by `build-vm-rootfs.mjs` (not a digest-pinned TCB artifact); the engine.ts change is TypeScript→dist. Adds a regression test asserting the exit frame is captured even in the same chunk as ready (verified to fail with the capture attached post-handshake).

  - **Probe actions + test fixes.** Added a `pid-info` probe action (`{ ok: process.pid > 1, pid }`) so the bootstrap-integrity test asserts the workload actually runs under vm-init (the previous `metadata` action only pinged the cloud IMDS endpoint and could never report a PID). Added an `http-fetch` probe action (fetch through the egress proxy with the session CA) and rewrote the L3 curl test to use `runProbe` — it previously called `backend.run()` directly and read `result.json.ok`, but `backend.run()` returns no `.json` (only `runProbe` populates it via `parseProbeJson`), so it threw `Cannot read properties of undefined`.

- Fix Linux CI failures in sandbox-vm-native (Code Audit unit-test job):

  - **native-binding (real bug, glibc):** the koffi struct declarations for
    `posix_spawn_file_actions_*` / `posix_spawnattr_*` used `_Out_` on `_init`
    and plain `_In_` on `_adddup2`/`_addclose`/`_setflags`. koffi store-and-
    forwards struct bytes per call — `_Out_` copies out to a fresh buffer and
    `_In_` discards it — so the adddup2 mutation never reached the final
    `posix_spawn`. Invisible on macOS (its file*actions_t is a heap pointer),
    fatal on glibc (file_actions_t is INLINE struct bytes): the child's dup2
    silently dropped, `spawn bridges real stdout` got empty stdout. Every
    mutating call is now `\_Inout*` so state round-trips through the object.
    Verified end-to-end on Linux amd64 (the spawn marker reaches the pipe) and
    macOS (no regression).
  - **executables-qualified (env gate):** the loopback-mount suite gated on
    Linux + mke2fs presence only. `mount -o loop` also needs CAP_SYS_ADMIN + a
    loop device — absent on unprivileged ubuntu-latest and even rootful Docker.
    Now probes the real capability (build + loop-mount + unmount a tiny ext4)
    in beforeAll; the suite runs only when the probe succeeds.
  - **tcb-manifest (cross-platform fixture):** fixtures hardcoded
    `libkrun.dylib`/`libkrunfw.dylib`; verifyVmTcb resolves `.so` on Linux, so
    the fixture lookup ENOENT'd on every non-macOS host. Platform-conditional
    LIBKRUN/LIBKRUNFW constants (mirrors the vm-helper-build fix in
    @agentoctopus/sandbox).
  - **fd-ceiling (env gate):** the C regression test unconditionally invokes
    `cc`. Gates on a `cc --version` probe so hosts without a C toolchain (e.g.
    node:slim) skip instead of failing the compile.

- 7241dbe: Fix Linux CI failures in sandbox-vm-native (Code Audit unit-test job):

  - **native-binding (real bug, glibc):** the koffi struct declarations for
    `posix_spawn_file_actions_*` / `posix_spawnattr_*` used `_Out_` on `_init`
    and plain `_In_` on `_adddup2`/`_addclose`/`_setflags`. koffi store-and-
    forwards struct bytes per call — `_Out_` copies out to a fresh buffer and
    `_In_` discards it — so the adddup2 mutation never reached the final
    `posix_spawn`. Invisible on macOS (its file*actions_t is a heap pointer),
    fatal on glibc (file_actions_t is INLINE struct bytes): the child's dup2
    silently dropped, `spawn bridges real stdout` got empty stdout. Every
    mutating call is now `\_Inout*` so state round-trips through the object.
    Verified end-to-end on Linux amd64 (the spawn marker reaches the pipe) and
    macOS (no regression).
  - **executables-qualified (env gate):** the loopback-mount suite gated on
    Linux + mke2fs presence only. `mount -o loop` also needs CAP_SYS_ADMIN + a
    loop device — absent on unprivileged ubuntu-latest and even rootful Docker.
    Now probes the real capability (build + loop-mount + unmount a tiny ext4)
    in beforeAll; the suite runs only when the probe succeeds.
  - **tcb-manifest (cross-platform fixture):** fixtures hardcoded
    `libkrun.dylib`/`libkrunfw.dylib`; verifyVmTcb resolves `.so` on Linux, so
    the fixture lookup ENOENT'd on every non-macOS host. Platform-conditional
    LIBKRUN/LIBKRUNFW constants (mirrors the vm-helper-build fix in
    @agentoctopus/sandbox).
  - **fd-ceiling (env gate):** the C regression test unconditionally invokes
    `cc`. Gates on a `cc --version` probe so hosts without a C toolchain (e.g.
    node:slim) skip instead of failing the compile.

- fix(sandbox-vm-native): consume probe-verified state at prepare/start; re-verify TCB/rootfs at boundaries

  - probe() now caches the fully verified TCB + gate-manifest state per engine
    instance; resolveRootfs()/assertRootfsQualified()/start() require it and
    never re-read gate-manifest.json — a post-probe swap with a self-consistent
    but unsigned gate is invisible to prepare().
  - Prepare boundary: all four TCB artifacts are re-verified (digest/symlink/
    mode) when resolveRootfs() runs, immediately before the image builder is
    consumed.
  - Launch boundary: start() re-verifies helper/libkrun/libkrunfw and re-hashes
    the rootfs image against its ref + the cached gate's qualifiedRootfsDigests
    immediately before exec/krun_add_disk. A gate, helper, library, builder, or
    rootfs swapped after probe() fails closed.

- e2ae62b: fix(sandbox-vm-native): consume probe-verified state at prepare/start; re-verify TCB/rootfs at boundaries

  - probe() now caches the fully verified TCB + gate-manifest state per engine
    instance; resolveRootfs()/assertRootfsQualified()/start() require it and
    never re-read gate-manifest.json — a post-probe swap with a self-consistent
    but unsigned gate is invisible to prepare().
  - Prepare boundary: all four TCB artifacts are re-verified (digest/symlink/
    mode) when resolveRootfs() runs, immediately before the image builder is
    consumed.
  - Launch boundary: start() re-verifies helper/libkrun/libkrunfw and re-hashes
    the rootfs image against its ref + the cached gate's qualifiedRootfsDigests
    immediately before exec/krun_add_disk. A gate, helper, library, builder, or
    rootfs swapped after probe() fails closed.

- fix(sandbox-vm-native): bind the release signature to the loaded gate manifest and fail closed on deletion

  - probe() now parses the Ed25519-signed release-manifest body after signature
    verification and requires canonical-digest equality with the gate manifest
    actually loaded, closing the mixed-state attack (a legitimately-signed old
    release manifest + swapped gate manifest / TCB / binaries).
  - A half pair (exactly one of release-manifest.json / .sig present) now fails
    closed unconditionally, and a file deleted between the existence check and
    the read (TOCTOU) fails closed instead of soft-degrading.
  - New engine option requireReleaseSignature, set by core's production
    buildEngineOpts, makes a release build fail closed when the signed pair is
    absent instead of degrading to unsigned dev mode. Dev boxes and CI harnesses
    that build engine opts without the flag keep the soft 'missing' path.

- a28c8ab: fix(sandbox-vm-native): bind the release signature to the loaded gate manifest and fail closed on deletion

  - probe() now parses the Ed25519-signed release-manifest body after signature
    verification and requires canonical-digest equality with the gate manifest
    actually loaded, closing the mixed-state attack (a legitimately-signed old
    release manifest + swapped gate manifest / TCB / binaries).
  - A half pair (exactly one of release-manifest.json / .sig present) now fails
    closed unconditionally, and a file deleted between the existence check and
    the read (TOCTOU) fails closed instead of soft-degrading.
  - New engine option requireReleaseSignature, set by core's production
    buildEngineOpts, makes a release build fail closed when the signed pair is
    absent instead of degrading to unsigned dev mode. Dev boxes and CI harnesses
    that build engine opts without the flag keep the soft 'missing' path.

- fix(sandbox-vm-native): soft-degrade when the release manifest is absent

  `probe()` treated the wired release-manifest PATHS as proof a signed manifest
  shipped — `buildEngineOpts` always fills both paths with prebuilds defaults,
  so on a dev box / unsigned build `readFile` threw ENOENT into the outer catch
  and the whole probe failed closed to `available:false`. The documented soft
  `releaseManifest:'missing'` path was unreachable. `haveReleaseManifest` now
  checks file EXISTENCE (both files), with an ENOENT-tolerant read as TOCTOU
  defense, so an absent pair degrades softly while a PRESENT-but-unverifiable
  pair still fails closed (`signature-invalid`).

- e7380bb: fix(sandbox-vm-native): soft-degrade when the release manifest is absent

  `probe()` treated the wired release-manifest PATHS as proof a signed manifest
  shipped — `buildEngineOpts` always fills both paths with prebuilds defaults,
  so on a dev box / unsigned build `readFile` threw ENOENT into the outer catch
  and the whole probe failed closed to `available:false`. The documented soft
  `releaseManifest:'missing'` path was unreachable. `haveReleaseManifest` now
  checks file EXISTENCE (both files), with an ENOENT-tolerant read as TOCTOU
  defense, so an absent pair degrades softly while a PRESENT-but-unverifiable
  pair still fails closed (`signature-invalid`).

- fix(sandbox-vm-native): pin staging dir atimes after the last read, not before (R7)

  `build-vm-rootfs.mjs` pinned the staging tree's atime/mtime to the fixed epoch
  _before_ walking it, and — more importantly — before mke2fs read it. On hosts
  without noatime, Linux relatime bumps a directory's atime to wall-clock the
  moment it is readdir'd (a pinned atime ≤ mtime is exactly the relatime
  trigger), so the directory atimes drifted to the build time and the sealed
  rootfs was not byte-for-byte reproducible across separate runs even though the
  same-run double-build passed.

  Two rules now hold:

  - `pinStagingTimes` walks POST-ORDER: a directory is utimes'd only after its
    children are processed, so its own readdir never comes after its utimes.
  - `buildOnce` re-pins the staging tree immediately after mke2fs returns — mke2fs
    -d readdir'd the whole tree, so the pin must be the last touch before the next
    build reads it. Build 1 and build 2 (and any later cross-run build) therefore
    read identical directory atimes.

- 9f7af63: fix(sandbox-vm-native): pin staging dir atimes after the last read, not before (R7)

  `build-vm-rootfs.mjs` pinned the staging tree's atime/mtime to the fixed epoch
  _before_ walking it, and — more importantly — before mke2fs read it. On hosts
  without noatime, Linux relatime bumps a directory's atime to wall-clock the
  moment it is readdir'd (a pinned atime ≤ mtime is exactly the relatime
  trigger), so the directory atimes drifted to the build time and the sealed
  rootfs was not byte-for-byte reproducible across separate runs even though the
  same-run double-build passed.

  Two rules now hold:

  - `pinStagingTimes` walks POST-ORDER: a directory is utimes'd only after its
    children are processed, so its own readdir never comes after its utimes.
  - `buildOnce` re-pins the staging tree immediately after mke2fs returns — mke2fs
    -d readdir'd the whole tree, so the pin must be the last touch before the next
    build reads it. Build 1 and build 2 (and any later cross-run build) therefore
    read identical directory atimes.

- fix(sandbox-vm-native): make VM guest workloads bootable — bundle node's loader/libc into the sealed rootfs + propagate workload exit codes

  The vm-lane G1/G2 qualification gates could never reach GO: guest-side
  diagnostics proved the launch-spec decode, the krun-stdio stdio relay, and
  the execve inputs were all correct, yet the guest halted within ~1ms of the
  execve. Two root causes:

  1. **Loaderless rootfs.** The sealed rootfs shipped the dynamically-linked
     nodejs.org `node` binary with NO ELF interpreter and NO libc — the guest
     kernel's execve of `/usr/bin/node` failed ENOENT (missing PT_INTERP), so
     no workload could ever run. `build-vm-rootfs.mjs` now discovers the node
     binary's interpreter + transitive `DT_NEEDED` closure via `readelf` and
     copies them into `/lib` (and the interpreter to its baked-in absolute
     path, `/lib/ld-linux-aarch64.so.1` or `/lib64/ld-linux-x86-64.so.2`) from
     the per-guest-arch library dirs CI provides (`OCTOPUS_ROOTFS_LIBS` for x64,
     `OCTOPUS_ROOTFS_LIBS_ARM64` for arm64 — the host multiarch dir and the
     aarch64 cross-toolchain dir). A dynamic node with no libs dir fails the
     build rather than shipping a loaderless rootfs. The workflow adds
     `libstdc++6-arm64-cross` (arm64 libstdc++.so.6) and exports both dirs.
     Guest vm-init/vsock-forwarder stay static (TCB-critical, independent of
     the node library set).

  2. **Lost exit codes.** libkrun's exit-code propagation is a virtiofs-only
     ioctl that no-ops on this sealed ext4 root, so the helper process always
     exited 0 regardless of workload status. `octopus-vm-init` now FORKS the
     workload, waitpid()s the child, and reports `{"exit":N}` (WEXITSTATUS, or
     128+WTERMSIG when signaled) over the octopus-control port; the engine
     treats that frame as authoritative over the helper's exit code (bounded
     settle wait so the frame is never dropped to a pipe-delivery race). The
     control fd is FD_CLOEXEC'd — not closed — across the execve, so execve
     failures now report `{"error":"execve failed: <errno>"}` (previously
     silenced by the pre-execve close) while the workload itself can never
     write a control frame.

  Also removes the temporary guest-side stdio diagnostics that proved the
  relay (diag frames, pre-exec sleep discriminator).

- 2240b81: fix(sandbox-vm-native): make VM guest workloads bootable — bundle node's loader/libc into the sealed rootfs + propagate workload exit codes

  The vm-lane G1/G2 qualification gates could never reach GO: guest-side
  diagnostics proved the launch-spec decode, the krun-stdio stdio relay, and
  the execve inputs were all correct, yet the guest halted within ~1ms of the
  execve. Two root causes:

  1. **Loaderless rootfs.** The sealed rootfs shipped the dynamically-linked
     nodejs.org `node` binary with NO ELF interpreter and NO libc — the guest
     kernel's execve of `/usr/bin/node` failed ENOENT (missing PT_INTERP), so
     no workload could ever run. `build-vm-rootfs.mjs` now discovers the node
     binary's interpreter + transitive `DT_NEEDED` closure via `readelf` and
     copies them into `/lib` (and the interpreter to its baked-in absolute
     path, `/lib/ld-linux-aarch64.so.1` or `/lib64/ld-linux-x86-64.so.2`) from
     the per-guest-arch library dirs CI provides (`OCTOPUS_ROOTFS_LIBS` for x64,
     `OCTOPUS_ROOTFS_LIBS_ARM64` for arm64 — the host multiarch dir and the
     aarch64 cross-toolchain dir). A dynamic node with no libs dir fails the
     build rather than shipping a loaderless rootfs. The workflow adds
     `libstdc++6-arm64-cross` (arm64 libstdc++.so.6) and exports both dirs.
     Guest vm-init/vsock-forwarder stay static (TCB-critical, independent of
     the node library set).

  2. **Lost exit codes.** libkrun's exit-code propagation is a virtiofs-only
     ioctl that no-ops on this sealed ext4 root, so the helper process always
     exited 0 regardless of workload status. `octopus-vm-init` now FORKS the
     workload, waitpid()s the child, and reports `{"exit":N}` (WEXITSTATUS, or
     128+WTERMSIG when signaled) over the octopus-control port; the engine
     treats that frame as authoritative over the helper's exit code (bounded
     settle wait so the frame is never dropped to a pipe-delivery race). The
     control fd is FD_CLOEXEC'd — not closed — across the execve, so execve
     failures now report `{"error":"execve failed: <errno>"}` (previously
     silenced by the pre-execve close) while the workload itself can never
     write a control frame.

  Also removes the temporary guest-side stdio diagnostics that proved the
  relay (diag frames, pre-exec sleep discriminator).

- Pre-create the guest mount points in the sealed rootfs so the read-only root can boot. The rootfs is mounted `ro` (by design — an immutable sealed image), so neither libkrun's `init_or_kernel` nor the guest `vm-init` can mkdir at runtime; the G1 gate failed on the first physical-runner boot with "Error creating directory (/proc) / Couldn't mount filesystems, bailing out". The staging skeleton now also creates `/proc` (procfs for libkrun init), `/sys` (vm-init scans /sys/class/virtio-ports), `/skill` (vm-init mounts /dev/vdb), and `/etc/skill-ca` (vm-init mounts /dev/vdc), matching the documented "mount points must pre-exist in the rootfs" intent. Changes the rootfs tree, so the producer emits a new sealed digest on the next build.
- a66e4be: Pre-create the guest mount points in the sealed rootfs so the read-only root can boot. The rootfs is mounted `ro` (by design — an immutable sealed image), so neither libkrun's `init_or_kernel` nor the guest `vm-init` can mkdir at runtime; the G1 gate failed on the first physical-runner boot with "Error creating directory (/proc) / Couldn't mount filesystems, bailing out". The staging skeleton now also creates `/proc` (procfs for libkrun init), `/sys` (vm-init scans /sys/class/virtio-ports), `/skill` (vm-init mounts /dev/vdb), and `/etc/skill-ca` (vm-init mounts /dev/vdc), matching the documented "mount points must pre-exist in the rootfs" intent. Changes the rootfs tree, so the producer emits a new sealed digest on the next build.
- fix(sandbox-vm-native): emit the runtime rootfs placement (rootfs/<ref>)

  build-vm-rootfs.mjs now copies the sealed rootfs image to
  `prebuilds/<arch>/rootfs/<ref>` in addition to the top-level `rootfs.img`.
  `engine.resolveRootfs()` resolves `rootfsDir/<ref>` at launch time, but the
  producer previously wrote only the top-level image consumed by
  run-vm-gates.mjs — so a VM launch could not locate the rootfs without
  workflow-side copying. Every producer (all CI lanes, local builds) now emits
  both placements with the 0444 seal preserved on the runtime copy.

- 30d718e: fix(sandbox-vm-native): emit the runtime rootfs placement (rootfs/<ref>)

  build-vm-rootfs.mjs now copies the sealed rootfs image to
  `prebuilds/<arch>/rootfs/<ref>` in addition to the top-level `rootfs.img`.
  `engine.resolveRootfs()` resolves `rootfsDir/<ref>` at launch time, but the
  producer previously wrote only the top-level image consumed by
  run-vm-gates.mjs — so a VM launch could not locate the rootfs without
  workflow-side copying. Every producer (all CI lanes, local builds) now emits
  both placements with the 0444 seal preserved on the runtime copy.

- fix(sandbox): verifyVmTcb returns the exact manifest it verified, closing the double-read substitution window

  probe() previously called verifyVmTcb() — which reads vm-tcb-manifest.json and
  verifies the on-disk binaries against it — and then re-read the same manifest
  path to build the digest set for the gate-manifest check. Between the two
  reads, an attacker could swap the file so one manifest verified the binaries
  while another's digests matched the signed gate (verification-result
  substitution). verifyVmTcb now returns { paths, manifest } — the exact
  manifest body the files were verified against — and probe() threads those
  digests without a second read.

- b43006c: fix(sandbox): verifyVmTcb returns the exact manifest it verified, closing the double-read substitution window

  probe() previously called verifyVmTcb() — which reads vm-tcb-manifest.json and
  verifies the on-disk binaries against it — and then re-read the same manifest
  path to build the digest set for the gate-manifest check. Between the two
  reads, an attacker could swap the file so one manifest verified the binaries
  while another's digests matched the signed gate (verification-result
  substitution). verifyVmTcb now returns { paths, manifest } — the exact
  manifest body the files were verified against — and probe() threads those
  digests without a second read.

- fix(sandbox-vm-native): bind VM execution to probe-verified objects (exec-path + object binding)

  - Exec-path binding: probe() realpath-enforces opts.helperPath against the
    verifyVmTcb()-verified helper BEFORE any exec (a divergent path fails
    closed and the BLK probe never runs; the probe execs the verified
    realpath). Core assembly realpath-enforces builderBinaryPath against
    artifactsDir/vm-image-builder (else unavailable), and VmImageBuilderImpl
    accepts a lazy path resolver — production wires
    () => engine.getVerifiedImageBuilderPath(), so the executed builder is the
    probe-verified one, never an independently configured path.
  - Object binding (closes the residual hash→exec TOCTOU): probe() copies the
    four verified artifacts into an engine-private 0700 dir, hashing the bytes
    as they are read for the copy from a single O_NOFOLLOW fd (digest must
    equal the verified manifest). Only those copies are executed/loaded —
    start() execs the private helper with LD/DYLD_LIBRARY_PATH forced to the
    private dir. resolveRootfs() opens the rootfs O_RDONLY|O_NOFOLLOW, hashes
    from that fd, and pins it; start() inherits it at fd 5 and the launch spec
    references /dev/fd/5, so the attached image is the verified inode even if
    the path is swapped after resolution. A post-probe swap of any TCB file or
    the rootfs is neutralized (regression-tested); only a pre-binding swap
    still fails closed on the from-fd digest check.
  - engine.close() releases the pinned rootfs fd and the private TCB dir;
    VmSandboxBackend.cleanup() invokes it (soft bucket).

- cbc1e3f: fix(sandbox-vm-native): bind VM execution to probe-verified objects (exec-path + object binding)

  - Exec-path binding: probe() realpath-enforces opts.helperPath against the
    verifyVmTcb()-verified helper BEFORE any exec (a divergent path fails
    closed and the BLK probe never runs; the probe execs the verified
    realpath). Core assembly realpath-enforces builderBinaryPath against
    artifactsDir/vm-image-builder (else unavailable), and VmImageBuilderImpl
    accepts a lazy path resolver — production wires
    () => engine.getVerifiedImageBuilderPath(), so the executed builder is the
    probe-verified one, never an independently configured path.
  - Object binding (closes the residual hash→exec TOCTOU): probe() copies the
    four verified artifacts into an engine-private 0700 dir, hashing the bytes
    as they are read for the copy from a single O_NOFOLLOW fd (digest must
    equal the verified manifest). Only those copies are executed/loaded —
    start() execs the private helper with LD/DYLD_LIBRARY_PATH forced to the
    private dir. resolveRootfs() opens the rootfs O_RDONLY|O_NOFOLLOW, hashes
    from that fd, and pins it; start() inherits it at fd 5 and the launch spec
    references /dev/fd/5, so the attached image is the verified inode even if
    the path is swapped after resolution. A post-probe swap of any TCB file or
    the rootfs is neutralized (regression-tested); only a pre-binding swap
    still fails closed on the from-fd digest check.
  - engine.close() releases the pinned rootfs fd and the private TCB dir;
    VmSandboxBackend.cleanup() invokes it (soft bucket).

- fix(sandbox-vm-native): relay guest workload stdio to the host via a named "krun-stdio" console port

  After the bootstrapArgv + cwd fixes, the G1/G2 qualification gates booted the
  guest, decoded the launch spec, and emitted `{"ready":true}` on the
  octopus-control port — but the probe's `G1-DONE`/`G2-DONE` markers never
  reached the host, so the gates NO-GO'd with "DONE marker absent" even though
  the guest halted cleanly (helper exit 0 in ~2s).

  Root cause: our custom `octopus-vm-init` is the guest PID 1 (libkrun's own
  init never runs), and at boot its fd 1 is a stray virtio-console port that
  goes nowhere — so the workload's `console.log` was lost. Routing the workload
  through the guest's implicit console (`/dev/console` == hvc0) and pointing
  libkrun's console output at the helper's stdout with `krun_set_console_output`
  still dropped every byte, whether targeted at `/dev/fd/1` or a `/dev/fd/6`
  alias: `krun_start_enter` "takes over stdin/stdout" (libkrun.h) and the
  implicit-console file sink never relays (verified twice: console tx events
  fire in the guest, clean shutdown, empty helper stdout). Meanwhile the named
  multiport port (octopus-control, real pipe fds 3/4) relays perfectly and
  survives the takeover — proof of the working mechanism.

  Fix — a second named port, "krun-stdio", on the SAME multiport console device
  as octopus-control, wired to real pipe fds (shared by the qualification gate
  AND real skill execution; no gate/engine bridging changes needed because both
  already consume `raw.stdout`/`raw.stdin`):

  - `vm-helper.c`: register `krun_add_console_port_inout(ctx, console_id,
"krun-stdio", input_fd=7, output_fd=6)` alongside octopus-control, drop the
    broken `krun_set_console_output` call, fail-closed-verify fds 6/7 are open
    before registration, and bump the launch mass-close watermark to 8 (keep
    0-7). Two inout ports on one multiport device do not panic libkrun
    (verified), unlike a second console device or /dev/null-backed input.
  - `vm-init.c`: `redirect_workload_stdio` now opens the "krun-stdio" port BY
    NAME (via /sys/class/virtio-ports) and dup2's it onto the workload's fd
    0/1/2 before execve — so workload output rides the port to the helper's
    stdout pipe (-> `raw.stdout` -> `vm.stdout`) and host writes to `raw.stdin`
    reach the workload's stdin.
  - `native-binding.ts`: the posix_spawn file actions now also dup2 the stdout
    pipe write end onto child fd 6 (the port's output) and a new stdin-relay
    pipe read end onto child fd 7 (the port's input); `raw.stdin` is a real
    fd-backed stream to that pipe (no longer a sentinel).
  - `engine.ts`: drop the now-dead `raw.stdin` override (workload stdin rides
    the krun-stdio port, not the host->guest control pipe — the control channel
    carries only ready/error frames).
  - `run-vm-gates.mjs`: relabel the returned streams to name the krun-stdio
    relay (the 90s fail-closed per-boot timeout from the previous change stays).

  Side benefit: removing `krun_set_console_output` restores libkrun's trace
  logging to the helper's stderr (the API had been redirecting the logger).

- e971270: fix(sandbox-vm-native): relay guest workload stdio to the host via a named "krun-stdio" console port

  After the bootstrapArgv + cwd fixes, the G1/G2 qualification gates booted the
  guest, decoded the launch spec, and emitted `{"ready":true}` on the
  octopus-control port — but the probe's `G1-DONE`/`G2-DONE` markers never
  reached the host, so the gates NO-GO'd with "DONE marker absent" even though
  the guest halted cleanly (helper exit 0 in ~2s).

  Root cause: our custom `octopus-vm-init` is the guest PID 1 (libkrun's own
  init never runs), and at boot its fd 1 is a stray virtio-console port that
  goes nowhere — so the workload's `console.log` was lost. Routing the workload
  through the guest's implicit console (`/dev/console` == hvc0) and pointing
  libkrun's console output at the helper's stdout with `krun_set_console_output`
  still dropped every byte, whether targeted at `/dev/fd/1` or a `/dev/fd/6`
  alias: `krun_start_enter` "takes over stdin/stdout" (libkrun.h) and the
  implicit-console file sink never relays (verified twice: console tx events
  fire in the guest, clean shutdown, empty helper stdout). Meanwhile the named
  multiport port (octopus-control, real pipe fds 3/4) relays perfectly and
  survives the takeover — proof of the working mechanism.

  Fix — a second named port, "krun-stdio", on the SAME multiport console device
  as octopus-control, wired to real pipe fds (shared by the qualification gate
  AND real skill execution; no gate/engine bridging changes needed because both
  already consume `raw.stdout`/`raw.stdin`):

  - `vm-helper.c`: register `krun_add_console_port_inout(ctx, console_id,
"krun-stdio", input_fd=7, output_fd=6)` alongside octopus-control, drop the
    broken `krun_set_console_output` call, fail-closed-verify fds 6/7 are open
    before registration, and bump the launch mass-close watermark to 8 (keep
    0-7). Two inout ports on one multiport device do not panic libkrun
    (verified), unlike a second console device or /dev/null-backed input.
  - `vm-init.c`: `redirect_workload_stdio` now opens the "krun-stdio" port BY
    NAME (via /sys/class/virtio-ports) and dup2's it onto the workload's fd
    0/1/2 before execve — so workload output rides the port to the helper's
    stdout pipe (-> `raw.stdout` -> `vm.stdout`) and host writes to `raw.stdin`
    reach the workload's stdin.
  - `native-binding.ts`: the posix_spawn file actions now also dup2 the stdout
    pipe write end onto child fd 6 (the port's output) and a new stdin-relay
    pipe read end onto child fd 7 (the port's input); `raw.stdin` is a real
    fd-backed stream to that pipe (no longer a sentinel).
  - `engine.ts`: drop the now-dead `raw.stdin` override (workload stdin rides
    the krun-stdio port, not the host->guest control pipe — the control channel
    carries only ready/error frames).
  - `run-vm-gates.mjs`: relabel the returned streams to name the krun-stdio
    relay (the 90s fail-closed per-boot timeout from the previous change stays).

  Side benefit: removing `krun_set_console_output` restores libkrun's trace
  logging to the helper's stderr (the API had been redirecting the logger).

- Updated dependencies [e0d70e8]
- Updated dependencies [82c1482]
- Updated dependencies [981ed72]
- Updated dependencies [907f4ea]
- Updated dependencies [c42c0b3]
- Updated dependencies [527f236]
- Updated dependencies [7208e49]
- Updated dependencies [5e85d3b]
- Updated dependencies [817e0c6]
- Updated dependencies [d4b64f2]
- Updated dependencies [3f54a3c]
- Updated dependencies [6bc7cd0]
- Updated dependencies
- Updated dependencies [689d833]
- Updated dependencies [eca3a3e]
- Updated dependencies [119a837]
- Updated dependencies
- Updated dependencies [773f76c]
- Updated dependencies [d0db1d7]
- Updated dependencies
- Updated dependencies [07980ee]
- Updated dependencies
- Updated dependencies [0f6ed4d]
- Updated dependencies [93d29b7]
- Updated dependencies
- Updated dependencies [e9f39ae]
- Updated dependencies [1c4e384]
- Updated dependencies
- Updated dependencies [575141f]
- Updated dependencies [94f4ca6]
- Updated dependencies [4cd6484]
- Updated dependencies
- Updated dependencies [521e64d]
- Updated dependencies [4876e12]
- Updated dependencies [c83e5c1]
- Updated dependencies
- Updated dependencies [395a999]
- Updated dependencies
- Updated dependencies [1da822a]
- Updated dependencies
- Updated dependencies [56d6b8b]
- Updated dependencies [a093b07]
- Updated dependencies [4360716]
- Updated dependencies [763827c]
- Updated dependencies
- Updated dependencies [79e7d44]
- Updated dependencies [9b792d8]
- Updated dependencies [651f879]
- Updated dependencies
- Updated dependencies [e45c517]
- Updated dependencies
- Updated dependencies [be42fa1]
- Updated dependencies
- Updated dependencies [0c5eea9]
- Updated dependencies [146ef8f]
- Updated dependencies [c449e9d]
- Updated dependencies [a27bf3d]
- Updated dependencies [000a440]
- Updated dependencies
- Updated dependencies [1442cc7]
- Updated dependencies
- Updated dependencies [7783966]
- Updated dependencies
- Updated dependencies [e2fc1d9]
- Updated dependencies
- Updated dependencies [4c0ac2c]
- Updated dependencies [c0343ed]
- Updated dependencies [a525160]
- Updated dependencies [44297c0]
- Updated dependencies [1cf3c5f]
- Updated dependencies [7256c9c]
- Updated dependencies [79c9b8f]
- Updated dependencies [d327a60]
- Updated dependencies
- Updated dependencies [42865c6]
- Updated dependencies
- Updated dependencies [3e5392d]
- Updated dependencies
- Updated dependencies [b43006c]
- Updated dependencies
- Updated dependencies [cbc1e3f]
  - @agentoctopus/sandbox@0.9.0
