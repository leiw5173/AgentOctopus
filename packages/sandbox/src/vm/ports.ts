// packages/sandbox/src/vm/ports.ts
// Leaf-package preserved: imports NOTHING from @agentoctopus/*.
import type { VerifiedArtifact, VmInstance, VmProbeResult, VmStartConfig } from './types.js';

export interface VmEnginePort {
  probe(): Promise<VmProbeResult>;
  resolveRootfs(ref: string): Promise<VerifiedArtifact>;
  assertRootfsQualified(ref: string): Promise<void>;
  // (R10 P1-1 cache-key docstring here — see spec lines 219–256)
  assertExecutablesQualified(ref: string, executables: Record<string, string>, bins: readonly string[]): Promise<void>;
  start(config: VmStartConfig): Promise<VmInstance>;
  close(): Promise<void>;
}

export interface VmImageBuilderPort {
  buildSnapshotImage(input: {
    sourceDir: string; expectedSnapshotDigest: string; outDir: string;
  }): Promise<VerifiedArtifact>;
  buildSingleFileImage(input: {
    sourcePath: string; guestName: string; expectedFileDigest: string; outDir: string;
  }): Promise<VerifiedArtifact>;
}

export type { VmStartConfig, VmInstance, VmProbeResult, VerifiedArtifact } from './types.js';
