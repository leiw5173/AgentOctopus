// packages/sandbox-vm-native/src/engine.ts
// VmEngineImpl: the leaf package's VM engine. `start()` spawns the libkrun
// helper subprocess with the R9/R10 control-pipe FD plumbing and waits for
// the guest's `{"ready":true}` handshake (or `{"error":...}` / early exit /
// readyTimeoutMs).
//
// WHY A SEAM (not a hard-coded addon): Node's child_process.spawn does NOT
// expose posix_spawn_file_actions_adddup2, F_DUPFD_CLOEXEC, or installing a
// raw fd into a fixed slot. The real binding is a tiny `.node` native addon
// (or koffi FFI) built by scripts/build-vm-helper.mjs (Task 15) and shipped
// in `prebuilds/`. To keep the FD-config logic unit-testable WITHOUT the
// compiled addon, `start()` consumes an injectable `deps` seam:
//
//   - deps.pipe()                 -> [readFd, writeFd]  (both cloexec)
//   - deps.dupFdCloexec(src, min) -> fd                 (F_DUPFD_CLOEXEC)
//   - deps.spawn(...)             -> VmInstanceRaw       (posix_spawn + actions)
//
// The L1 test injects fakes; production wires the real binding. probe() and
// the assert*() helpers exercise the real on-disk TCB / gate / rootfs checks
// (deep-imported from @agentoctopus/sandbox — that package has no `exports`
// field, so dist/ deep imports resolve) and the existing
// assertExecutablesQualified in this package.
//
// FD OWNERSHIP (R9/R10, read the spec's R9/R10 section for the full picture):
//   H2G pipe: [h2gRead, h2gWrite]  — host→guest control (host writes, guest reads fd0)
//   G2H pipe: [g2hRead, g2hWrite]  — guest→host control (guest writes fd4, host reads)
//   Helper fixed slots: fd0 = H2G read, fd4 = G2H write (vm-helper.c H2G_READ_FD/G2H_WRITE_FD).
//   R10 P1-2: h2gRead / g2hWrite are moved to F_DUPFD_CLOEXEC temp slots ≥10
//   BEFORE adddup2(temp → 3) + adddup2(temp → 4). temp ≥10 ≠ 3/4 ⇒ the dup2
//   is always a REAL dup2 (clears FD_CLOEXEC on the target), never a no-op.
//   Darwin: POSIX_SPAWN_CLOEXEC_DEFAULT closes everything else across exec.
//   Linux: every pipe end is O_CLOEXEC; the dup2 targets survive exec.
//   After spawn the PARENT (Node) closes its own h2gRead + g2hWrite + the
//   two temp slots, and RETAINS g2hRead (to read ready/error/exit frames)
//   and h2gWrite (to send future commands). The helper's fd0/fd4 are its own
//   dup'd copies, independent of what Node does to the originals.
import { PassThrough } from 'node:stream';
import { execFile } from 'node:child_process';
import { createReadStream, createWriteStream, existsSync } from 'node:fs';
import { readFile, stat } from 'node:fs/promises';
import { createHash } from 'node:crypto';
import path from 'node:path';
import type {
  VmEnginePort,
  VmInstance,
  VmProbeResult,
  VmStartConfig,
  VerifiedArtifact,
} from '@agentoctopus/sandbox';
import { assertExecutablesQualified } from './executables-qualified.js';
import { createLoopbackStatRootfsFile } from './rootfs-loopback-mount.js';
import { buildHelperLaunchSpec } from './helper-launch-spec.js';

// Deep imports into @agentoctopus/sandbox/dist — that package has NO `exports`
// field (only main/types), so deep module resolution reaches dist/. These are
// the TCB / gate / release-manifest / digest helpers that are intentionally
// NOT re-exported from the sandbox index (leaf packages consume them directly).
const SANDBOX_DIST = '@agentoctopus/sandbox/dist/vm';
type VmTcbArtifacts = {
  helper: string; libkrun: string; libkrunfw: string; imageBuilder: string;
} & Record<string, string>;
type GateManifest = {
  platform: 'darwin-arm64' | 'linux-x64';
  schemaVersion: 1;
  artifacts: { libkrun: string; libkrunfw: string; helper: string; imageBuilder: string };
  qualifiedRootfsDigests: string[];
  libkrunAbi: 'v1.19.4';
  blkFeatureRequired: true;
  gates: { G1: 'GO' | 'NO-GO'; G2: 'GO' | 'NO-GO' };
  gateReasons: string[];
  qualifiedAt: string;
  manifestDigest: string;
};

/**
 * Lazily-resolved deep-import surface from @agentoctopus/sandbox/dist/vm.
 * Combined here (rather than as separate dynamic imports at each call site)
 * so probe()/resolveRootfs()/assertRootfsQualified() share one import result
 * per engine instance. Returns the gate-manifest + TCB + release-manifest
 * helpers (not re-exported from the sandbox index by design).
 */
export interface SandboxVmHelpers {
  verifyGateManifest: (
    m: GateManifest,
    loaded: { libkrun: string; libkrunfw: string; helper: string; imageBuilder: string },
  ) => { ok: boolean; reasons: string[] };
  isRootfsQualified: (m: GateManifest, rootfsRef: string) => boolean;
  verifyOuterReleaseManifest: (outerBytes: Buffer, signature: Buffer) =>
    | { ok: true; reason: 'ok' }
    | { ok: false; reason: 'no-key' | 'bad-signature' };
  /** Canonical digest of a gate manifest body (sha256, minus manifestDigest). */
  computeManifestDigest: (m: GateManifest) => string;
  GateManifestSchema: { parse: (u: unknown) => GateManifest };
  verifyVmTcb: (input: { artifactsDir: string; manifestPath: string }) =>
    Promise<VmTcbArtifacts>;
}

async function loadSandboxVm(): Promise<SandboxVmHelpers> {
  const gate = await import(/* @vite-ignore */ SANDBOX_DIST + '/gate-manifest.js') as Pick<
    SandboxVmHelpers,
    'verifyGateManifest' | 'isRootfsQualified' | 'verifyOuterReleaseManifest' | 'computeManifestDigest' | 'GateManifestSchema'
  >;
  const tcb = await import(/* @vite-ignore */ SANDBOX_DIST + '/vm-helper-build.js') as Pick<
    SandboxVmHelpers,
    'verifyVmTcb'
  >;
  return { ...gate, ...tcb };
}

/** Maximum tolerated non-empty, non-JSON control frames during the ready handshake. */
const MAX_MALFORMED_FRAMES = 2;

/** Helper fixed control-fd slots (must match vm-helper.c H2G_READ_FD/G2H_WRITE_FD). */
const H2G_READ_FD = 3;
const G2H_WRITE_FD = 4;
/** Minimum temp slot for F_DUPFD_CLOEXEC — comfortably above 0/1/2/3/4. */
const DUPFD_MIN = 10;

/** A single file_actions entry handed to the spawn binding. */
export type SpawnFileAction =
  | { kind: 'adddup2'; src: number; target: number }
  | { kind: 'addclose'; fd: number };

/**
 * The raw child returned by `deps.spawn`. stdio here are the helper's
 * fd1/fd2 (workload stdout/stderr) bridged into Node streams; the control
 * read stream is the parent's g2hRead end. `exited` resolves with the helper
 * subprocess exit status (krun_start_enter is authoritative inside the helper).
 */
export interface VmInstanceRaw {
  stdin: NodeJS.WritableStream;
  stdout: NodeJS.ReadableStream;
  stderr: NodeJS.ReadableStream;
  /** Parent's g2hRead end — ready/error/exit frames arrive here. */
  controlRead: NodeJS.ReadableStream;
  exited: Promise<{ exitCode: number; timedOut: boolean }>;
  kill: () => Promise<void>;
  close: () => Promise<void>;
}

/** Injectable native-binding seam. L1 injects fakes; production wires the addon. */
export interface VmEngineDeps {
  platform: 'darwin-arm64' | 'linux-x64' | 'unsupported';
  /** Native pipe(): returns [readFd, writeFd], both cloexec. */
  pipe: () => Promise<[number, number]> | [number, number];
  /** fcntl(src, F_DUPFD_CLOEXEC, min) → smallest fresh fd ≥ min, cloexec. */
  dupFdCloexec: (src: number, min: number) => Promise<number> | number;
  /** posix_spawn the helper with the given file actions + attr flags. */
  spawn: (
    helperPath: string,
    argv: string[],
    env: NodeJS.ProcessEnv,
    fileActions: SpawnFileAction[],
    spawnAttrFlags: string[],
    parentCloseFds: number[],
  ) => Promise<VmInstanceRaw> | VmInstanceRaw;
}

export interface VmEngineOptions {
  /** Absolute path to the compiled vm-helper binary (TCB-verified by probe()). */
  helperPath: string;
  /** Directory holding the verified TCB artifacts (helper, libkrun, libkrunfw, image-builder). */
  artifactsDir: string;
  /** Path to the TCB manifest JSON (vm-tcb-manifest.json) consumed by verifyVmTcb. */
  tcbManifestPath: string;
  /** Path to the gate manifest JSON (gate-manifest.json) loaded + verified by probe(). */
  gateManifestPath: string;
  /** Path to the outer release manifest JSON (signature verified by probe()). */
  releaseManifestPath?: string;
  /** Path to the outer release manifest Ed25519 signature (detached, base64). */
  releaseManifestSignaturePath?: string;
  /**
   * Fail closed when the signed release-manifest pair is ABSENT. Default
   * false: an absent pair degrades softly to releaseManifest:'missing' so
   * dev boxes and fork-PR CI lanes (no signing secret) stay usable.
   * Production assembly (core's buildEngineOpts) sets this TRUE — a shipped
   * native package IS a release build, so a missing signature pair is a
   * tampered install, not a dev box. This compiled-in requirement is the
   * "this is a release build" marker: deleting both files from an install
   * cannot roll it back to unsigned dev mode.
   */
  requireReleaseSignature?: boolean;
  /** Directory holding the resolved rootfs artifact files (named by digest). */
  rootfsDir: string;
}

export class VmEngineImpl implements VmEnginePort {
  /** Lazily-resolved deep-import helpers (TCB + gate + release manifest). */
  private sandboxVm: Promise<SandboxVmHelpers> | undefined;
  /**
   * The absolute path of the rootfs artifact most recently resolved by
   * resolveRootfs(). assertExecutablesQualified needs a real on-disk path to
   * stat guest files against, and the backend orchestrator calls these two
   * methods in sequence (resolveRootfs → assertExecutablesQualified), so the
   * engine threads the resolved path between them.
   */
  private resolvedRootfsPath: string | undefined;

  constructor(
    private readonly opts: VmEngineOptions,
    private readonly deps: VmEngineDeps,
  ) {}

  private sandbox(): Promise<SandboxVmHelpers> {
    if (!this.sandboxVm) this.sandboxVm = loadSandboxVm();
    return this.sandboxVm;
  }

  private async probeBlkFeature(): Promise<boolean> {
    return new Promise((resolve, reject) => {
      execFile(this.opts.helperPath, ['--has-blk'], { timeout: 10_000 }, (err, _stdout, _stderr) => {
        if (err) {
          // execFile sets err.code to the exit status for non-zero exits.
          if (typeof err.code === 'number') {
            resolve(err.code === 0);
          } else {
            // Spawn failure (ENOENT, EACCES, etc.) — fail closed.
            reject(err);
          }
        } else {
          resolve(true);
        }
      });
    });
  }

  async probe(): Promise<VmProbeResult> {
    // Platform gate first — no point touching disk on an unsupported host.
    if (this.deps.platform === 'unsupported') {
      return {
        available: false,
        platform: 'unsupported',
        reason: 'unsupported host platform for VM sandbox',
      };
    }
    try {
      const sv = await this.sandbox();
      // (1) Verify TCB artifacts (helper, libkrun, libkrunfw, image-builder)
      //     against the on-disk vm-tcb-manifest — digest/size/mode/symlink/
      //     group-writable checks. Throws on any mismatch.
      const artifacts = await sv.verifyVmTcb({
        artifactsDir: this.opts.artifactsDir,
        manifestPath: this.opts.tcbManifestPath,
      });
      // (1b) verifyVmTcb returns FILE PATHS (digest/size/mode-checked against
      //     the TCB manifest on disk), but verifyGateManifest compares the gate
      //     manifest's pinned `artifacts[k]` (sha256:<hex>) refs to
      //     `loadedArtifactDigests[k]` — so the digests, not the paths, must be
      //     threaded across. Re-read the TCB manifest (already trust-verified by
      //     verifyVmTcb: its own artifact sha256 values were just matched to the
      //     on-disk files) and surface those pinned digests as the loaded set.
      //     This closes the gap between the two verifiers without recomputing
      //     sha256 over the files a second time (verifyVmTcb already did).
      const tcbRaw = JSON.parse(await readFile(this.opts.tcbManifestPath, 'utf8')) as {
        artifacts: { libkrun: { sha256: string }; libkrunfw: { sha256: string }; helper: { sha256: string }; imageBuilder: { sha256: string } };
      };
      const loadedArtifactDigests = {
        libkrun: 'sha256:' + tcbRaw.artifacts.libkrun.sha256,
        libkrunfw: 'sha256:' + tcbRaw.artifacts.libkrunfw.sha256,
        helper: 'sha256:' + tcbRaw.artifacts.helper.sha256,
        imageBuilder: 'sha256:' + tcbRaw.artifacts.imageBuilder.sha256,
      };
      void artifacts; // file paths used downstream by start(); probe() needs only digests.
      // (2) Load + verify the gate manifest. It carries the qualified rootfs
      //     digests list and pins libkrunAbi='v1.19.4' + blkFeatureRequired.
      let gateManifest: GateManifest;
      try {
        const raw = await readFile(this.opts.gateManifestPath, 'utf8');
        gateManifest = sv.GateManifestSchema.parse(JSON.parse(raw));
      } catch (err) {
        return {
          available: false,
          platform: this.deps.platform,
          reason: `gate manifest load/parse failed: ${err instanceof Error ? err.message : String(err)}`,
          gateManifest: 'missing',
        };
      }
      // The gate manifest self-hashes its own body (minus manifestDigest); the
      // verifier re-checks that plus G1/G2 GO and that the loaded TCB artifact
      // digests match what the manifest pins.
      const gate = sv.verifyGateManifest(gateManifest, loadedArtifactDigests);
      if (!gate.ok) {
        return {
          available: false,
          platform: this.deps.platform,
          reason: `gate manifest verification failed: ${gate.reasons.join('; ')}`,
          gateManifest: 'digest-mismatch',
          gateReasons: gate.reasons,
        };
      }
      // (3) Outer release-manifest signature (Ed25519) — a fail-closed state
      //     machine over the detached pair (release-manifest.json + .sig):
      //       - EXACTLY ONE file present → fail closed ('signature-invalid').
      //         A half-pair only exists through deletion or a half-shipped
      //         release — the producer writes both atomically and the pack job
      //         enforces both — so deleting the .sig must never degrade a
      //         signed build to unsigned mode.
      //       - BOTH present → read + verify + BIND. Any failure — a TOCTOU
      //         read error (file deleted between existsSync and read), an
      //         unparseable signed body, 'bad-signature', 'no-key', or a
      //         signed body that does not match the gate manifest loaded in
      //         step (2) — fails closed.
      //       - NEITHER present → soft 'missing' (dev box / fork-PR lane with
      //         no signing secret) UNLESS opts.requireReleaseSignature is set
      //         → fail closed. Production assembly (core's buildEngineOpts)
      //         sets it, so deleting BOTH files from an installed release
      //         cannot roll it back to unsigned dev mode.
      let releaseManifest: 'verified' | 'missing' | 'signature-invalid' = 'missing';
      const releasePairWired =
        !!this.opts.releaseManifestPath && !!this.opts.releaseManifestSignaturePath;
      const manifestExists = releasePairWired && existsSync(this.opts.releaseManifestPath!);
      const sigExists = releasePairWired && existsSync(this.opts.releaseManifestSignaturePath!);
      if (releasePairWired && manifestExists !== sigExists) {
        return {
          available: false,
          platform: this.deps.platform,
          reason: 'release manifest pair incomplete: exactly one of release-manifest.json / release-manifest.json.sig is present (deletion or half-shipped release)',
          gateManifest: 'verified',
          releaseManifest: 'signature-invalid',
        };
      }
      if (manifestExists && sigExists) {
        let outerBytes: Buffer;
        let sigB64: string;
        try {
          [outerBytes, sigB64] = await Promise.all([
            readFile(this.opts.releaseManifestPath!),
            readFile(this.opts.releaseManifestSignaturePath!, 'utf8'),
          ]);
        } catch (err) {
          // TOCTOU: a file removed between the existsSync gate and the read is
          // the same deletion attack as the half-pair case — fail CLOSED,
          // never soft-degrade to 'missing'.
          return {
            available: false,
            platform: this.deps.platform,
            reason: `release manifest unreadable during probe: ${err instanceof Error ? err.message : String(err)}`,
            gateManifest: 'verified',
            releaseManifest: 'signature-invalid',
          };
        }
        const signature = Buffer.from(sigB64.trim(), 'base64');
        const verifyResult = sv.verifyOuterReleaseManifest(outerBytes, signature);
        if (!verifyResult.ok) {
          // bad-signature = tampered/wrong-key; no-key = trust root never
          // committed. Neither is acceptable for a claimed signed release.
          return {
            available: false,
            platform: this.deps.platform,
            reason: verifyResult.reason === 'no-key'
              ? 'release manifest present but trust root key not committed (release-key.ts placeholder)'
              : 'outer release manifest signature invalid',
            gateManifest: 'verified',
            releaseManifest: 'signature-invalid',
          };
        }
        // BINDING: the Ed25519 signature covers the release-manifest BYTES
        // alone. Without binding those bytes to the gate manifest actually
        // loaded + verified in step (2), an attacker keeps a legitimately-
        // signed OLD release-manifest.json while replacing gate-manifest.json
        // + the TCB manifest + the binaries: the gate self-hash still passes
        // (self-consistent) and the signature verifies an unrelated file.
        // Parse the signed body and require canonical-digest equality with
        // the loaded gate manifest. Byte-comparing the files is impossible
        // (the producer signs compact JSON.stringify output; the on-disk
        // gate-manifest.json is pretty-printed), so compare
        // computeManifestDigest — sha256 over the canonical JSON body minus
        // the manifestDigest field.
        let signedManifest: GateManifest;
        try {
          signedManifest = sv.GateManifestSchema.parse(JSON.parse(outerBytes.toString('utf8')));
        } catch (err) {
          return {
            available: false,
            platform: this.deps.platform,
            reason: `signed release manifest body is not a valid gate manifest: ${err instanceof Error ? err.message : String(err)}`,
            gateManifest: 'verified',
            releaseManifest: 'signature-invalid',
          };
        }
        if (sv.computeManifestDigest(signedManifest) !== sv.computeManifestDigest(gateManifest)) {
          return {
            available: false,
            platform: this.deps.platform,
            reason: 'signed release manifest does not bind to the loaded gate manifest (canonical digest mismatch)',
            gateManifest: 'verified',
            releaseManifest: 'signature-invalid',
          };
        }
        releaseManifest = 'verified';
      } else if (this.opts.requireReleaseSignature) {
        return {
          available: false,
          platform: this.deps.platform,
          reason: 'release manifest required (requireReleaseSignature) but no signed release-manifest pair is present',
          gateManifest: 'verified',
          releaseManifest: 'missing',
        };
      }
      // (4) Real BLK feature probe via the TCB-verified helper. Fail-closed:
      //     if libkrun was not built with KRUN_FEATURE_BLK, the helper exits 1.
      let blkFeature: 'present' | 'absent';
      try {
        blkFeature = (await this.probeBlkFeature()) ? 'present' : 'absent';
      } catch (err) {
        return {
          available: false,
          platform: this.deps.platform,
          reason: `BLK feature probe failed: ${err instanceof Error ? err.message : String(err)}`,
          gateManifest: 'verified',
          blkFeature: 'absent',
        };
      }
      if (blkFeature === 'absent') {
        return {
          available: false,
          platform: this.deps.platform,
          reason: 'libkrun BLK feature not available',
          gateManifest: 'verified',
          blkFeature: 'absent',
        };
      }
      return {
        available: true,
        platform: this.deps.platform,
        gateManifest: 'verified',
        blkFeature: 'present',
        releaseManifest,
      };
    } catch (err) {
      return {
        available: false,
        platform: this.deps.platform,
        reason: err instanceof Error ? err.message : String(err),
      };
    }
  }

  async resolveRootfs(ref: string): Promise<VerifiedArtifact> {
    // The rootfs ref is a block-image byte digest (sha256:<64hex>). Resolution
    // re-reads the on-disk file under rootfsDir, recomputes its sha256, and
    // asserts equality with the ref (TOCTOU-closed) before returning the
    // artifact. The returned artifact is STORED by the backend orchestrator as
    // its rootfsArtifact, so this MUST return a real VerifiedArtifact — never
    // throw on the success path. Qualification (is the ref in the gate
    // manifest's qualifiedRootfsDigests[]) is a separate gate, exercised by
    // assertRootfsQualified(); here we only verify the bytes match the ref.
    const sv = await this.sandbox();
    let gateManifest: GateManifest;
    try {
      const raw = await readFile(this.opts.gateManifestPath, 'utf8');
      gateManifest = sv.GateManifestSchema.parse(JSON.parse(raw));
    } catch {
      throw new Error(`resolveRootfs: gate manifest missing/unparseable; cannot qualify ${ref}`);
    }
    if (!sv.isRootfsQualified(gateManifest, ref)) {
      throw new Error(`resolveRootfs: ref not in qualifiedRootfsDigests: ${ref}`);
    }
    const absolutePath = path.join(this.opts.rootfsDir, ref);
    let st: Awaited<ReturnType<typeof stat>>;
    try {
      st = await stat(absolutePath);
    } catch (err) {
      throw new Error(`resolveRootfs: cannot stat rootfs file ${absolutePath}: ${err instanceof Error ? err.message : String(err)}`);
    }
    const hash = createHash('sha256');
    try {
      const stream = createReadStream(absolutePath);
      for await (const chunk of stream) {
        hash.update(chunk as Buffer);
      }
    } catch (err) {
      throw new Error(`resolveRootfs: cannot read rootfs file ${absolutePath}: ${err instanceof Error ? err.message : String(err)}`);
    }
    const recomputed = 'sha256:' + hash.digest('hex');
    if (recomputed !== ref) {
      throw new Error(`resolveRootfs: byte digest mismatch (expected ${ref}, got ${recomputed})`);
    }
    // Stash the resolved path so the subsequent assertExecutablesQualified call
    // can stat guest files against it without the backend re-threading it.
    this.resolvedRootfsPath = absolutePath;
    return {
      ref,
      absolutePath,
      // The rootfs manifestDigest IS its byte ref — a rootfs is a sealed
      // artifact whose tree identity is the sealed bytes themselves (there is
      // no separate source tree to snapshot, unlike skill block images).
      manifestDigest: ref,
      size: st.size,
      mode: st.mode & 0o777,
    };
  }

  async assertRootfsQualified(ref: string): Promise<void> {
    const sv = await this.sandbox();
    let gateManifest: GateManifest;
    try {
      const raw = await readFile(this.opts.gateManifestPath, 'utf8');
      gateManifest = sv.GateManifestSchema.parse(JSON.parse(raw));
    } catch {
      throw new Error(`assertRootfsQualified: gate manifest missing/unparseable; cannot qualify ${ref}`);
    }
    if (!sv.isRootfsQualified(gateManifest, ref)) {
      throw new Error(`assertRootfsQualified: ref not in qualifiedRootfsDigests: ${ref}`);
    }
  }

  async assertExecutablesQualified(
    ref: string,
    executables: Record<string, string>,
    bins: readonly string[],
  ): Promise<void> {
    // Delegate to the existing native-pkg function. It walks the rootfs to
    // confirm every executable/bin resolves only to paths allowed by the
    // mount-shadow rules. It needs the resolved rootfs path (set by
    // resolveRootfs) and a real stat seam against the rootfs file.
    const rootfsPath = this.resolvedRootfsPath;
    if (!rootfsPath) {
      throw new Error(
        'assertExecutablesQualified: no resolved rootfs path — resolveRootfs must be called first',
      );
    }
    // Real stat seam (HI-2): mount the rootfs image read-only per call and stat
    // the guest path. The loopback mount needs CAP_SYS_ADMIN, available on the
    // privileged-Linux CI lane where the VM backend's prepare() runs. The
    // factory is fail-closed: on non-Linux it throws rather than silently
    // returning null (a mount failure must never degrade to "all executables
    // qualified"). The VM lane on macOS cannot loopback-mount ext4, so the
    // production path that exercises this runs only where CAP_SYS_ADMIN is
    // available; the previous stub (always-null) is gone.
    await assertExecutablesQualified(ref, executables, bins, {
      rootfsPath,
      statRootfsFile: createLoopbackStatRootfsFile(),
    });
  }

  async start(config: VmStartConfig): Promise<VmInstance> {
    // Contract: bootstrapArgv is exactly [bootstrapPath, <launch-spec blob>].
    // The helper execs argv[0] (bootstrapPath) with argv[1] as the CBOR
    // launch spec; a malformed argv would let the guest exec an arbitrary
    // binary, so this is a security gate, not a convenience check.
    if (!Array.isArray(config.bootstrapArgv) || config.bootstrapArgv.length !== 2) {
      throw new Error(
        `bootstrapArgv must be [bootstrapPath, launchSpecBlob] (length 2); got length ${config.bootstrapArgv?.length}`,
      );
    }
    if (config.bootstrapArgv[0] !== config.bootstrapPath) {
      throw new Error(
        `bootstrapArgv[0] must equal bootstrapPath (${config.bootstrapPath}); got ${config.bootstrapArgv[0]}`,
      );
    }
    if (config.libkrunAbi !== 'v1.19.4') {
      throw new Error(
        `unsupported libkrun ABI: ${config.libkrunAbi} (only v1.19.4 is pinned)`,
      );
    }

    // The helper's argv[1] is the base64url(JSON) helper launch spec, NOT the
    // guest bootstrapArgv. The guest bootstrapArgv is NESTED inside the spec.
    const helperSpecToken = buildHelperLaunchSpec(config, config.trustedEnv ?? []);
    const argv = [this.opts.helperPath, helperSpecToken];

    // --- R9 P1-1: two cloexec pipes, read end FIRST, write SECOND. ---
    const [h2gRead, h2gWrite] = await this.deps.pipe(); // host→guest
    const [g2hRead, g2hWrite] = await this.deps.pipe(); // guest→host

    // --- R10 P1-2: move h2gRead + g2hWrite to F_DUPFD_CLOEXEC temp slots ≥10.
    // This guarantees the subsequent adddup2(temp → 3/4) has source ≠ target,
    // so it is a REAL dup2 that clears FD_CLOEXEC on the target fd. If we
    // dup2'd the raw 3 (or 4) into 3 (or 4) it would be a no-op that leaves
    // the cloexec bit SET — the helper would lose the fd across exec. ---
    const tempH2gRead = await this.deps.dupFdCloexec(h2gRead, DUPFD_MIN);
    const tempG2hWrite = await this.deps.dupFdCloexec(g2hWrite, DUPFD_MIN);
    if (tempH2gRead < DUPFD_MIN || tempG2hWrite < DUPFD_MIN) {
      throw new Error(
        `F_DUPFD_CLOEXEC returned a fd below ${DUPFD_MIN} (tempH2gRead=${tempH2gRead}, tempG2hWrite=${tempG2hWrite}); R10 P1-2 source≠target invariant cannot be guaranteed`,
      );
    }
    if (tempH2gRead === tempG2hWrite) {
      throw new Error(
        'F_DUPFD_CLOEXEC returned the same temp fd for h2gRead and g2hWrite; collision',
      );
    }

    // --- File actions installed in the helper (child) by posix_spawn. ---
    // Order matters: adddup2(tempH2gRead → 3) gives the helper its H2G read
    // end at fd 3; adddup2(tempG2hWrite → 4) gives it its G2H write end at
    // fd 4. The temp fds themselves are cloexec so they DON'T survive exec —
    // only the dup2'd targets at 3/4 do (dup2 clears cloexec on the target).
    const fileActions: SpawnFileAction[] = [
      { kind: 'adddup2', src: tempH2gRead, target: H2G_READ_FD },
      { kind: 'adddup2', src: tempG2hWrite, target: G2H_WRITE_FD },
    ];

    // --- Spawn attributes. Darwin uses POSIX_SPAWN_CLOEXEC_DEFAULT to close
    // every other inherited fd across exec (the temp slots are cloexec too,
    // belt-and-suspenders). Linux relies on O_CLOEXEC per-end (set by the
    // native pipe binding) plus the dup2'd 3/4 surviving exec. ---
    const spawnAttrFlags: string[] =
      this.deps.platform === 'darwin-arm64'
        ? ['POSIX_SPAWN_CLOEXEC_DEFAULT']
        : [];

    // --- fds the PARENT (Node) must close AFTER spawn: its own copies of the
    // ends the helper now owns (h2gRead via temp→3, g2hWrite via temp→4) plus
    // the temp slots themselves. Node RETAINS g2hRead (read frames) and
    // h2gWrite (send commands). ---
    const parentCloseFds = [h2gRead, g2hWrite, tempH2gRead, tempG2hWrite];

    const libPathVar =
      this.deps.platform === 'darwin-arm64' ? 'DYLD_LIBRARY_PATH' : 'LD_LIBRARY_PATH';

    const env: NodeJS.ProcessEnv = {
      PATH: process.env.PATH ?? '',
      OCTOPUS_VSOCK_PORT: String(config.vsockPort),
      OCTOPUS_VSOCK_HOST_SOCKET: config.vsockHostSocket,
      OCTOPUS_VM_MEM_MIB: String(config.memMib),
      OCTOPUS_VM_CPUS: String(config.cpus),
    };
    if (process.env[libPathVar]) {
      env[libPathVar] = process.env[libPathVar];
    }

    const raw = await this.deps.spawn(
      this.opts.helperPath,
      argv,
      env,
      fileActions,
      spawnAttrFlags,
      parentCloseFds,
    );

    // --- Approach A: bridge the retained control + stdin fds HERE, before
    // waitForReady(). The engine created g2hRead/h2gWrite via deps.pipe() and
    // retains them (engine.ts:475-476, NOT in parentCloseFds:519). The binding
    // cannot bridge them because the locked spawn() signature does not carry
    // the retained fd numbers. The VmInstanceRaw doc-comment (engine.ts:122-
    // 132) says controlRead IS the parent's g2hRead end; waitForReady()
    // attaches data/end listeners to raw.controlRead (683-685), so it MUST be
    // a real fd-backed stream emitting the guest's {"ready":true} frame — an
    // empty PassThrough would hang until readyTimeoutMs and throw (CR-5
    // review Critical #1). autoClose:false keeps fd ownership with the
    // VmInstance lifecycle.
    //
    // We only override when the binding tags its placeholder with
    // `__octopusNeedsEngineOverride` (the production koffi binding does this;
    // the L1 fake returns a real working PassThrough and must NOT be
    // clobbered — its fds are fake numbers).
    const rawAny = raw as {
      controlRead: NodeJS.ReadableStream & { __octopusNeedsEngineOverride?: boolean };
      stdin: NodeJS.WritableStream & { __octopusNeedsEngineOverride?: boolean };
    };
    if (rawAny.controlRead?.__octopusNeedsEngineOverride) {
      rawAny.controlRead = createReadStream('', { fd: g2hRead, autoClose: false });
    }
    if (rawAny.stdin?.__octopusNeedsEngineOverride) {
      rawAny.stdin = createWriteStream('', { fd: h2gWrite, autoClose: false });
    }

    // --- Ready handshake: wait for {"ready":true} on g2hRead, or {"error":...},
    // or helper exit before ready, or readyTimeoutMs. EOF on g2hRead before
    // ready is treated as a start failure (the helper closed its write end
    // without signaling ready). ---
    const ready = await this.waitForReady(raw, config.readyTimeoutMs);
    if (!ready.ok) {
      // Best-effort cleanup of the half-started helper before propagating.
      try {
        await raw.kill();
      } catch {
        /* swallow — the start-failure error is the signal we care about */
      }
      throw new Error(ready.reason);
    }

    // --- Bridge helper stdio (fd1/fd2) + control into a VmInstance. exited
    // mirrors the helper subprocess exit (krun_start_enter authoritative). ---
    const stdin = new PassThrough();
    const stdout = new PassThrough();
    const stderr = new PassThrough();
    raw.stdout.pipe(stdout);
    raw.stderr.pipe(stderr);
    stdin.pipe(raw.stdin);
    // Drain controlRead after ready so the guest's later {"exit"}-equivalent
    // (helper exit) and any diagnostic frames don't back up the pipe.
    raw.controlRead.on('data', () => {
      /* intentionally drained; exit status comes from `exited` */
    });

    return {
      stdin,
      stdout,
      stderr,
      exited: raw.exited,
      kill: async () => {
        await raw.kill();
      },
      close: async () => {
        try {
          stdin.end();
        } catch {
          /* ignore */
        }
        await raw.close();
      },
    };
  }

  async close(): Promise<void> {
    // Stateless engine; instances own their own lifecycle. Nothing to close.
  }

  /**
   * Wait for the guest ready handshake on the control (g2hRead) stream.
   * Frames are newline-delimited JSON: `{"ready":true}` or
   * `{"error":"<msg>"}`. Resolves ok=true on ready; ok=false with a reason
   * on error-frame / EOF-before-ready / helper-exit-before-ready / timeout.
   */
  private waitForReady(
    raw: VmInstanceRaw,
    readyTimeoutMs: number,
  ): Promise<{ ok: true } | { ok: false; reason: string }> {
    return new Promise((resolve) => {
      let settled = false;
      let buf = '';
      let exitHandled = false;

      const finish = (r: { ok: true } | { ok: false; reason: string }) => {
        if (settled) return;
        settled = true;
        clearTimeout(timer);
        raw.controlRead.off('data', onData);
        raw.controlRead.off('end', onEnd);
        raw.controlRead.off('error', onError);
        resolve(r);
      };

      const timer = setTimeout(() => {
        finish({ ok: false, reason: `VM ready handshake timed out after ${readyTimeoutMs}ms` });
      }, readyTimeoutMs);

      let malformedCount = 0;

      const onFrame = (line: string) => {
        const trimmed = line.trim();
        if (!trimmed) return;
        let parsed: unknown;
        try {
          parsed = JSON.parse(trimmed);
        } catch {
          malformedCount++;
          if (malformedCount > MAX_MALFORMED_FRAMES) {
            finish({ ok: false, reason: `${malformedCount} malformed control frames` });
          }
          return; // tolerate a small amount of stderr bleed-through
        }
        const obj = parsed as { ready?: boolean; error?: string };
        if (obj.ready === true) {
          finish({ ok: true });
        } else if (typeof obj.error === 'string') {
          finish({ ok: false, reason: obj.error });
        }
      };

      const onData = (chunk: Buffer) => {
        buf += chunk.toString('utf8');
        let nl: number;
        while ((nl = buf.indexOf('\n')) >= 0) {
          const line = buf.slice(0, nl);
          buf = buf.slice(nl + 1);
          onFrame(line);
        }
      };
      const onEnd = () => {
        if (buf.trim()) onFrame(buf);
        finish({ ok: false, reason: 'helper closed control channel before ready (EOF)' });
      };
      const onError = (err: Error) => {
        finish({ ok: false, reason: `control channel error: ${err.message}` });
      };

      // Helper exit before ready ⇒ start failure. Promises have no cancellation,
      // so we just ignore a late resolution once settled.
      raw.exited.then(
        (status) => {
          if (exitHandled) return;
          exitHandled = true;
          finish({
            ok: false,
            reason: `helper exited before ready (exitCode=${status.exitCode}, timedOut=${status.timedOut})`,
          });
        },
        () => {
          if (exitHandled) return;
          exitHandled = true;
          finish({ ok: false, reason: 'helper exited before ready (rejected)' });
        },
      );

      raw.controlRead.on('data', onData);
      raw.controlRead.on('end', onEnd);
      raw.controlRead.on('error', onError);
    });
  }
}
