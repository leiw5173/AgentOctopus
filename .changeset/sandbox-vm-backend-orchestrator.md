---
"@agentoctopus/sandbox": minor
---

Add VmSandboxBackend orchestrator (probe/prepareTopology/prepare/spawn/run/cleanup) implementing the SandboxBackend contract using VmEnginePort + VmImageBuilderPort. Wires Tasks 1-8: resolves/asserts rootfs qualification, builds skill + CA block images, encodes the CBOR launch-spec into bootstrapArgv, and enforces fail-closed cleanup via ContainmentCleanupError when VmInstance.kill fails (memoized). Includes collectBoundedVmResult (output cap + timeout -> vm.kill) and L2 fake-driven tests (FakeVmEngine, FakeVmImageBuilder).
