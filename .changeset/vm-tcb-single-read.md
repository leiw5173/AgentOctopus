---
'@agentoctopus/sandbox': patch
'@agentoctopus/sandbox-vm-native': patch
---

fix(sandbox): verifyVmTcb returns the exact manifest it verified, closing the double-read substitution window

probe() previously called verifyVmTcb() — which reads vm-tcb-manifest.json and
verifies the on-disk binaries against it — and then re-read the same manifest
path to build the digest set for the gate-manifest check. Between the two
reads, an attacker could swap the file so one manifest verified the binaries
while another's digests matched the signed gate (verification-result
substitution). verifyVmTcb now returns { paths, manifest } — the exact
manifest body the files were verified against — and probe() threads those
digests without a second read.
