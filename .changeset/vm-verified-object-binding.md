---
'@agentoctopus/sandbox-vm-native': patch
'@agentoctopus/sandbox': patch
'@agentoctopus/core': patch
---

fix(sandbox-vm-native): bind VM execution to probe-verified objects (exec-path + object binding)

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
