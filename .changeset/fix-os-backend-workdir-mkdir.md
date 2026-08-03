---
'@agentoctopus/sandbox': patch
---

fix(sandbox): create the OS-backend workDir before assembleRootfs mkdtemps into it

`OsSandboxBackend` assigned `this.workDir` in the constructor but only created
it later (the launch-spec `mkdir`). `assembleRootfs()` then ran
`mkdtemp(join(workDir, 'rootfs-'))` against a parent that did not exist yet, so
every privileged-linux lane test died with
`ENOENT: no such file or directory, mkdtemp '.../oct-os-backend-*/rootfs-*'`.

Create the workDir (`mkdir recursive, 0700`) immediately before the assemble
call. The later launch-spec `mkdir` is idempotent (recursive) so this is a pure
ordering fix — no behavior change beyond removing the ENOENT.
