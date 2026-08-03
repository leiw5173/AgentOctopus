---
"@agentoctopus/sandbox": patch
---

os-helper: read the per-mount vfs options (mountinfo field 6), not the superblock options (field 10), when asserting a mount is read-only. The read-only flag is a per-mount flag (MNT_READONLY) set by the bind's ro-remount and reported in field 6, BEFORE the "-" separator. Field 10 reflects the underlying superblock (the rw ext4 the runtime root was bound FROM) and stays "rw" for a read-only bind — so the previous field-10 check always reported a correctly ro-remounted bind as writable and refused to exec ("mount / is not read-only"). The guard now validates the flag that the remount actually sets.
