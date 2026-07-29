// packages/sandbox/tests/vm/fakes.ts
import { PassThrough } from 'node:stream';
import type { VmEnginePort, VmImageBuilderPort, VmInstance, VmProbeResult, VmStartConfig, VerifiedArtifact } from '../../src/vm/ports.js';

export interface FakeEngineOpts {
  available?: boolean;
  startThrows?: boolean;
  killRejects?: boolean;
  readyDelayMs?: number;
}
export class FakeVmEngine implements VmEnginePort {
  startCalls: VmStartConfig[] = [];
  probeCalls = 0;
  private inst: FakeVmInstance | undefined;
  constructor(private opts: FakeEngineOpts = {}) {}
  async probe(): Promise<VmProbeResult> {
    this.probeCalls++;
    return {
      available: this.opts.available ?? true,
      platform: 'darwin-arm64',
      gateManifest: 'verified',
      blkFeature: 'present',
      releaseManifest: 'verified',
    };
  }
  async resolveRootfs(ref: string): Promise<VerifiedArtifact> {
    return { ref, absolutePath: '/rootfs.img', manifestDigest: ref, size: 1000, mode: 0o444 };
  }
  async assertRootfsQualified(_ref: string): Promise<void> {}
  async assertExecutablesQualified(_ref: string, _executables: Record<string, string>, _bins: readonly string[]): Promise<void> {}
  async start(config: VmStartConfig): Promise<VmInstance> {
    this.startCalls.push(config);
    if (this.opts.startThrows) throw new Error('start failed');
    this.inst = new FakeVmInstance(this.opts.killRejects ?? false);
    return this.inst;
  }
  async close(): Promise<void> {}
  get instance() { return this.inst; }
}

export class FakeVmInstance implements VmInstance {
  stdin = new PassThrough();
  stdout = new PassThrough();
  stderr = new PassThrough();
  killed = false;
  private exitCode = 0;
  private exitReject: ((e: Error) => void) | undefined;
  exited: Promise<{ exitCode: number; timedOut: boolean }>;
  constructor(private killRejects: boolean) {
    this.exited = new Promise((res, rej) => {
      this.exitReject = rej;
      // resolve when kill() or a normal exit is signaled
      (this as any)._resolve = res;
    });
  }
  resolveExit(code: number) { (this as any)._resolve({ exitCode: code, timedOut: false }); }
  async kill(): Promise<void> {
    this.killed = true;
    if (this.killRejects) throw new Error('kill failed');
    this.resolveExit(137);
  }
  async close(): Promise<void> { this.resolveExit(0); }
}

export class FakeVmImageBuilder implements VmImageBuilderPort {
  async buildSnapshotImage(input: { sourceDir: string; expectedSnapshotDigest: string; outDir: string }): Promise<VerifiedArtifact> {
    return { ref: 'sha256:skill', absolutePath: input.outDir + '/skill.img', manifestDigest: input.expectedSnapshotDigest, size: 100, mode: 0o444 };
  }
  async buildSingleFileImage(input: { sourcePath: string; guestName: string; expectedFileDigest: string; outDir: string }): Promise<VerifiedArtifact> {
    return { ref: 'sha256:ca', absolutePath: input.outDir + '/ca.img', manifestDigest: input.expectedFileDigest, size: 50, mode: 0o444 };
  }
}
