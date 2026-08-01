---
'@agentoctopus/sandbox': patch
---

fix(sandbox): retry the cgroup attach read-back on a bounded budget

`OsSandboxBackend.spawn` attaches the SIGSTOPped helper child to its session
cgroup via `attach()` before SIGCONT — the security gate that confines the child
before execve. Node's `spawn()` returns the pid the instant fork completes, but
the kernel cgroup membership of a freshly spawned, self-stopped child can take a
moment to settle on a busy CI host; the single write+immediate read-back could
transiently miss the pid and abort the run with "cgroup.procs read-back does not
contain pid … — refusing to continue unconfined" (10 privileged-linux tests).

`attach()` now retries the write+read-back on a short bounded budget (10 × 25ms)
and stays FAIL-CLOSED: if the pid never lands in the leaf (helper genuinely
exited or was refused), it still throws and never SIGCONTs an unconfined child.
