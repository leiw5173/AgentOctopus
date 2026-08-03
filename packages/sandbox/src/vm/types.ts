// packages/sandbox/src/vm/types.ts
// Leaf-clean assembly-boundary DTOs. Imports NOTHING from @agentoctopus/*.

export interface VmProbeResult {
  available: boolean;
  platform: 'darwin-arm64' | 'linux-x64' | 'unsupported';
  reason?: string;
  gateManifest?: 'verified' | 'missing' | 'digest-mismatch';
  gateReasons?: string[];
  blkFeature?: 'present' | 'absent';
  releaseManifest?: 'verified' | 'missing' | 'signature-invalid';
}

/**
 * Backend-internal pre-encoding object (R7 P1-3). Constructed + validated in
 * spawn(), CBOR+base64url-encoded into the launch-spec blob that becomes the
 * sole bootstrapArgv entry (guest argv[1]), then discarded. Does
 * NOT cross into the native layer as a VmStartConfig field.
 */
export interface VmWorkloadSpec {
  executable: string;
  argv: string[];
  cwd: string;
  env: string[];
  allowedExecutables: Record<string, string>;
}

export interface VmStartConfig {
  rootfsArtifact: VerifiedArtifact;
  skillBlockImage: VerifiedArtifact;
  caBlockImage: VerifiedArtifact;
  bootstrapPath: string;
  bootstrapArgv: string[];
  vsockPort: number;
  vsockHostSocket: string;
  memMib: number;
  cpus: number;
  readyTimeoutMs: number;
  libkrunAbi: 'v1.19.4';
  /** Environment strings ("KEY=value") passed to the helper and into the guest. */
  trustedEnv?: string[];
}

export interface VmInstance {
  readonly stdin: NodeJS.WritableStream;
  readonly stdout: NodeJS.ReadableStream;
  readonly stderr: NodeJS.ReadableStream;
  readonly exited: Promise<{ exitCode: number; timedOut: boolean }>;
  kill(): Promise<void>;
  close(): Promise<void>;
}

export interface VerifiedArtifact {
  ref: string;
  absolutePath: string;
  manifestDigest: string;
  size: number;
  mode: number;
}
