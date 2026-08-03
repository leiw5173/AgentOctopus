---
"@agentoctopus/sandbox": patch
---

Fix a deterministic `produce-linux-artifacts` self-check failure that blocked the vm-lane from ever running.

**Root cause.** `verifyRuntimeArtifact` (throwaway/scratch path) and `assembleRootfs` cleanup removed the extracted runtime tree with `rm(root, { recursive: true, force: true })`. The runtime rootfs ships read-only entries (e.g. `opt/octopus-boot/undici/LICENSE`), and Node's `force: true` swallows `ENOENT` but **not `EACCES`** — `rmdir`/`unlink` require write+execute on the *parent* directory, so a read-only directory anywhere in the extracted tree made the cleanup abort with `EACCES: permission denied, unlink '…/undici/LICENSE'`. Worse, because the cleanup runs in a `finally`, that `EACCES` masked the real verification result. Observed as a deterministic failure of the Sandbox Security `produce-linux-artifacts` self-check on the Linux runner (two consecutive runs), which gated off `vm-lane` entirely.

**Fix.** New `removeExtractedTree()` helper: a best-effort pass chmods the tree user-writable (dirs `0o700`, files `0o600`, symlinks skipped so chmod never follows them) before the authoritative `rm`. Failures in the chmod pass are ignored — the tree may already be partly gone. Wired into both cleanup sites. The helper is exported (documented as not-public-API) so the regression test can drive it directly.

**Test.** Adds a regression test that builds a tree with a read-only directory (`0o555`) + read-only file (`0o444`) — the exact CI EACCES signature — and asserts `removeExtractedTree` removes it fully. Verified to fail with `EACCES … unlink …/undici/LICENSE` on the pre-fix plain-`rm` cleanup and pass with the chmod pass. (It targets the helper directly rather than the full verify path because the extracted-tree allowlist walk correctly rejects a read-only *directory* in the manifest — extra mode bits vs the extractor's `0o755` — so the EACCES can't be reached end-to-end through `verifyRuntimeArtifact`.)
