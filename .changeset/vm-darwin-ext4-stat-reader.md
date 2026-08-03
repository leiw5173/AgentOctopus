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
