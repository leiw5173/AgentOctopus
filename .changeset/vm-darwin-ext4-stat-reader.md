---
"@agentoctopus/sandbox-vm-native": patch
---

feat(sandbox-vm-native): darwin ext4 stat reader for executable qualification

The darwin-arm64 vm-lane failed all 16 L3/L4 tests at `prepare()` with
`RootfsMountError: loopback rootfs mount is only available on Linux (got
darwin)`. `assertExecutablesQualified` — the fail-closed check that every
`vmRuntime.executables` value is a regular, non-symlink, exec-bit file inside
the verified rootfs — had only ONE stat seam: the Linux CAP_SYS_ADMIN loopback
mount. macOS cannot mount ext4, and no darwin stat mechanism existed (the
design assumed this stat-walk would only ever run on the privileged-Linux
lane).

Add a self-contained ext4 READER: a `stat` mode on the `vm-image-builder` C
tool that parses the mke2fs-produced rootfs directly (no mount, no external
binary), reading via the SAME pinned O_NOFOLLOW fd `resolveRootfs()` already
verified. It implements superblock/group-descriptor/inode parse, an
extent-tree walk, and a linear directory walk — sufficient for the small,
shallow guest tree (no htree is ever instantiated). It fails closed (non-zero
exit → throw) on anything unexpected: an indirect-block inode, a hash-indexed
directory, a bad extent magic, or a malformed/truncated image. Symlinks are
detected from `i_mode` WITHOUT being followed (mirrors the loopback
`statInMount` lstat-primary rule). A new `createExt4StatRootfsFile()` TS seam
shells out to it; `engine.assertExecutablesQualified` selects it on darwin
(Linux keeps the loopback mount unchanged). Covered by a byte-exact synthetic
ext4 fixture (mke2fs is unavailable on the dev box) exercising the full
verdict matrix + the three fail-closed rejections.
