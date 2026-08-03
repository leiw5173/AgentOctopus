---
"@agentoctopus/sandbox": minor
---

Add VM backend consumer-side contract types (VmProbeResult, VmWorkloadSpec, VmStartConfig, VmInstance, VerifiedArtifact), port interfaces (VmEnginePort, VmImageBuilderPort), and errors (ExecutablesUnqualifiedError, LaunchSpecTooLargeError, RunSpecError) under packages/sandbox/src/vm/. Leaf-package boundary enforced: vm/ports.ts and vm/types.ts import nothing from @agentoctopus/*.
