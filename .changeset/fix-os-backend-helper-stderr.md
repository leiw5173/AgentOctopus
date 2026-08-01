---
'@agentoctopus/sandbox': patch
---

fix(sandbox): surface the OS helper's early stderr when cgroup attach hits ESRCH

When the OS helper dies before it can self-stop (a phase-1/phase-2 `die()` —
netns, mount, chroot, or launch-spec parse), `spawn()`'s cgroup `attach()` fails
with `ESRCH: no such process`, which on its own is silent about WHY the helper
exited. The helper always writes its diagnostic to fd 2 before `_exit(127)`, but
the backend only wired up the stderr pipe after attach succeeded — so the reason
was lost and the privileged lane reported a bare ESRCH.

`spawn()` now buffers the helper's stderr from the moment of spawn (bounded, and
defensively against non-EventEmitter test doubles), and on attach failure
appends the helper's own diagnostic to the thrown error. The buffered bytes are
kept out of the skill's stderr stream once the pipes are wired after SIGCONT.
