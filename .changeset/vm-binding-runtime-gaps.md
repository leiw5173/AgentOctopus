---
'@agentoctopus/sandbox-vm-native': patch
---

fix(sandbox-vm-native): close the runtime gaps in the verified-object binding

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
