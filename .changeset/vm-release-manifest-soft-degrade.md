---
'@agentoctopus/sandbox-vm-native': patch
---

fix(sandbox-vm-native): soft-degrade when the release manifest is absent

`probe()` treated the wired release-manifest PATHS as proof a signed manifest
shipped — `buildEngineOpts` always fills both paths with prebuilds defaults,
so on a dev box / unsigned build `readFile` threw ENOENT into the outer catch
and the whole probe failed closed to `available:false`. The documented soft
`releaseManifest:'missing'` path was unreachable. `haveReleaseManifest` now
checks file EXISTENCE (both files), with an ENOENT-tolerant read as TOCTOU
defense, so an absent pair degrades softly while a PRESENT-but-unverifiable
pair still fails closed (`signature-invalid`).
