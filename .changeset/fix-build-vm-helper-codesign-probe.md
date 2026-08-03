---
"@agentoctopus/sandbox-vm-native": patch
---

Fix a false-negative `codesign` availability probe in `build-vm-helper.mjs`. The Darwin ad-hoc signing path probed the tool with `codesign --version`, but Apple's `codesign` does not accept a `--version` flag — it exits with code 2 ("unrecognized option") even though the binary exists and is on PATH. `execFileAsync` rejects on any non-zero exit, so the `try/catch` misreported a present `codesign` as "not on PATH … install Xcode command line tools" and died before signing (observed on the macOS vm-lane). The probe now treats only an `ENOENT` spawn failure as "not on PATH" and proceeds on any other exit code, letting the real signing call surface an actual `codesign` error if one exists.
