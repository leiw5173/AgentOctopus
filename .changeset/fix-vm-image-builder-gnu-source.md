---
'@agentoctopus/sandbox-vm-native': patch
---

fix(sandbox-vm-native): define _GNU_SOURCE so vm-image-builder.c compiles under -std=c11

build-vm-helper compiles vm-image-builder.c with `-std=c11 -Wall -Wextra
-Werror`. Strict ISO C11 (`__STRICT_ANSI__`) hides the descriptor-relative
syscalls and flags the writer depends on — openat/fdopendir/fchmod plus
O_CLOEXEC/O_NOFOLLOW/F_DUPFD_CLOEXEC (POSIX.1-2008) and O_DIRECTORY (a GNU
extension) — so the produce-linux-artifacts compile failed with "implicit
declaration" / "undeclared" errors. This is a latent bug: the VM TCB chain had
never built before, so the file had never been compiled.

Define `_GNU_SOURCE` before the includes: it overrides the strict-ISO hiding
(and implies POSIX.1-2008 + _ATFILE_SOURCE), exposing every symbol the file
uses. Also correct the header comment that falsely claimed "pure portable POSIX
... builds on macOS AND Linux" (O_DIRECTORY is Linux/GNU-only). Verified:
compiles clean with the exact CI flags on Ubuntu (gcc, glibc).
