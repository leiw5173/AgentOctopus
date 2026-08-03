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
import { pipeline } from 'node:stream/promises';
import { execFile } from 'node:child_process';
import { constants, createReadStream, createWriteStream, existsSync } from 'node:fs';
import { mkdtemp, open, readdir, readFile, realpath, rm, symlink } from 'node:fs/promises';
import { createHash } from 'node:crypto';
import { tmpdir } from 'node:os';
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
import { createExt4StatRootfsFile } from './rootfs-ext4-stat.js';
import { buildHelperLaunchSpec } from './helper-launch-spec.js';

// Deep imports into @agentoctopus/sandbox/dist — that package has NO `exports`
// field (only main/types), so deep module resolution reaches dist/. These are
// the TCB / gate / release-manifest / digest helpers that are intentionally
// NOT re-exported from the sandbox index (leaf packages consume them directly).
const SANDBOX_DIST = '@agentoctopus/sandbox/dist/vm';
type VmTcbArtifacts = {
  helper: string; libkrun: string; libkrunfw: string; imageBuilder: string;
} & Record<string, string>;
type VmTcbManifestShape = {
  artifacts: {
    libkrun: { sha256: string; size: number; mode: number };
    libkrunfw: { sha256: string; size: number; mode: number };
    helper: { sha256: string; size: number; mode: number };
    imageBuilder: { sha256: string; size: number; mode: number };
  };
};
/**
 * The TCB + gate state probe() verified end to end (TCB binaries ↔ manifest,
 * gate manifest ↔ loaded digests, release signature ↔ loaded gate). Set once
 * per successful probe(). resolveRootfs()/assertRootfsQualified()/start()
 * consume ONLY this instance: they never re-read gate-manifest.json (a
 * post-probe swap with a self-consistent but UNSIGNED gate is invisible).
 *
 * tcbPaths here are the ENGINE-PRIVATE COPIES probe() made of the verified
 * artifacts (see copyVerifiedArtifact): the bytes hashed as they were copied
 * from a single O_NOFOLLOW fd matched the manifest verifyVmTcb verified, and
 * only these copies are ever executed/loaded afterwards. A post-probe swap of
 * the original on-disk paths is therefore irrelevant — there is no
 * hash→exec window to close because the used object IS the verified object.
 */
interface VerifiedProbeState {
  gateManifest: GateManifest;
  tcbManifest: VmTcbManifestShape;
  /** Engine-private copies (0700 dir) of the four verified TCB artifacts. */
  tcbPaths: VmTcbArtifacts;
  /** The engine-private 0700 directory holding the tcbPaths copies. */
  privateDir: string;
}
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
    Promise<{ paths: VmTcbArtifacts; manifest: VmTcbManifestShape }>;
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
/** Fixed fd slot the rootfs image is inherited at; the launch spec references /dev/fd/5. */
const ROOTFS_INHERIT_FD = 5;
/** Minimum temp slot for F_DUPFD_CLOEXEC — comfortably above 0-7 (the child's
 * stdio 0/1/2, control 3/4, rootfs 5, and krun-stdio port 6/7). */
const DUPFD_MIN = 10;

/** A single file_actions entry handed to the spawn binding. */
export type SpawnFileAction =
  | { kind: 'adddup2'; src: number; target: number }
  | { kind: 'addclose'; fd: number };

/**
 * The raw child returned by `deps.spawn`. stdout/stderr are Node streams over
 * the pipes the binding dup2'd into the child (fd1/fd2); the guest workload's
 * stdout rides the "krun-stdio" named console port onto that same stdout pipe
 * (child fd 6). stdin is the host end of the krun-stdio port's input pipe
 * (writes reach the workload's fd 0). The control read stream is the parent's
 * g2hRead end. `exited` resolves with the helper subprocess exit status
 * (krun_start_enter is authoritative inside the helper).
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
  /**
   * Base directory under which probe() mkdtemp()s the engine-private 0700
   * directory for the verified TCB copies. Defaults to os.tmpdir(). Test seam.
   */
  privateDirBase?: string;
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
  /**
   * The open O_RDONLY|O_NOFOLLOW file handle resolveRootfs() pinned for the
   * resolved rootfs. The digest was hashed FROM THIS FD and the fd is kept
   * open until close() — start() inherits it into the helper (referenced as
   * /dev/fd/N), so the attached image is the verified inode even if the path
   * is replaced after resolveRootfs().
   */
  private resolvedRootfsHandle:
    | Awaited<ReturnType<typeof open>>
    | undefined;
  /** The ref the pinned rootfs fd was resolved for (start() asserts equality). */
  private resolvedRootfsRef: string | undefined;
  /** See VerifiedProbeState — the sole gate/TCB source after a successful probe(). */
  private verifiedProbe: VerifiedProbeState | undefined;

  constructor(
    private readonly opts: VmEngineOptions,
    private readonly deps: VmEngineDeps,
  ) {}

  private sandbox(): Promise<SandboxVmHelpers> {
    if (!this.sandboxVm) this.sandboxVm = loadSandboxVm();
    return this.sandboxVm;
  }

  /**
   * Fail-closed accessor for the probe()-verified state. prepare()/start()
   * must never consult the on-disk gate manifest or trust unverified file
   * bytes, so they require a successful probe() to have cached it first.
   */
  private requireVerifiedProbe(method: string): VerifiedProbeState {
    const v = this.verifiedProbe;
    if (!v) {
      throw new Error(`${method}: engine.probe() must succeed first — no verified TCB/gate state is cached`);
    }
    return v;
  }

  /**
   * Copy one probe-verified artifact into the engine-private directory,
   * hashing the bytes AS THEY ARE READ FOR THE COPY from a single
   * O_RDONLY|O_NOFOLLOW fd: the digest must equal the manifest entry
   * verifyVmTcb() verified. Hash object == copied object == the object that
   * will be executed/loaded — a swap of the source path between verifyVmTcb()
   * and this copy fails closed on digest mismatch, and after the copy the
   * original path is never used again (no hash→exec window).
   */
  private async copyVerifiedArtifact(
    name: 'helper' | 'libkrun' | 'libkrunfw' | 'imageBuilder',
    srcPath: string,
    expectedSha256: string,
    destDir: string,
  ): Promise<string> {
    const src = await open(srcPath, constants.O_RDONLY | constants.O_NOFOLLOW);
    const destPath = path.join(destDir, path.basename(srcPath));
    try {
      const hash = createHash('sha256');
      const readStream = createReadStream('', { fd: src.fd, autoClose: false });
      readStream.on('data', (c: Buffer) => hash.update(c));
      await pipeline(readStream, createWriteStream(destPath, { mode: 0o555 }));
      const digest = hash.digest('hex');
      if (digest !== expectedSha256) {
        await rm(destPath, { force: true }).catch(() => {});
        throw new Error(
          `probe: TCB artifact ${name} changed between verification and copy (digest mismatch)`,
        );
      }
      return destPath;
    } finally {
      await src.close().catch(() => {});
    }
  }

  /**
   * Recreate the versioned SONAME shims inside the engine-private dir, pointing
   * at the VERIFIED private copies. Linux: `libkrun.so.1 → libkrun.so`,
   * `libkrunfw.so.5 → libkrunfw.so`. Darwin: `libkrun.1.dylib → libkrun.dylib`,
   * `libkrunfw.5.dylib → libkrunfw.dylib` (created by vendor-libkrun.mjs in the
   * artifacts dir). The helper's DT_NEEDED / dyld install names use the
   * VERSIONED names on BOTH platforms — verifyVmTcb resolves the realpath
   * (libkrun.dylib), so the private copy carries the unversioned basename and
   * without these shims the loader cannot find the versioned name in the
   * private dir (the BLK probe's `dyld: Library not loaded: libkrun.1.dylib`)
   * — or worse, falls back to an UNVERIFIED same-named system library. Link
   * targets are always the private copy's basename (never the original
   * symlink's target), so an attacker-crafted link in the artifacts dir only
   * controls which NAMES we create, not what they resolve to.
   */
  private async mirrorSonameLinks(
    privateDir: string,
    privatePaths: VmTcbArtifacts,
  ): Promise<void> {
    const entries = await readdir(this.opts.artifactsDir).catch(() => [] as string[]);
    for (const entry of entries) {
      // Linux versioned SONAME (libkrun.so.1) OR Darwin versioned dylib
      // (libkrun.1.dylib). Skip the unversioned real files themselves.
      if (!/^libkrun(fw)?(\.so\..+|\.\d+\.dylib)$/.test(entry)) continue;
      const base = entry.startsWith('libkrunfw') ? 'libkrunfw' : 'libkrun';
      await symlink(path.basename(privatePaths[base]), path.join(privateDir, entry));
    }
  }

  private probeBlkFeature(helperPath: string, libDir: string): Promise<boolean> {
    // The probe execs the PRIVATE verified copy with the loader path pointed
    // at the private dir — the helper is dynamically linked against libkrun
    // (krun_has_feature), so the verified libs must be the ones loaded.
    const libPathVar =
      this.deps.platform === 'darwin-arm64' ? 'DYLD_LIBRARY_PATH' : 'LD_LIBRARY_PATH';
    const env: NodeJS.ProcessEnv = {
      PATH: process.env.PATH ?? '',
      [libPathVar]: libDir,
    };
    return new Promise((resolve, reject) => {
      execFile(helperPath, ['--has-blk'], { timeout: 10_000, env }, (err, _stdout, _stderr) => {
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
      // Re-probe invalidates previously verified state + its private copies:
      // the new verification must not silently inherit a stale private dir.
      if (this.verifiedProbe) {
        const dir = this.verifiedProbe.privateDir;
        this.verifiedProbe = undefined;
        if (dir) await rm(dir, { recursive: true, force: true }).catch(() => {});
      }
      const sv = await this.sandbox();
      // (1) Verify TCB artifacts (helper, libkrun, libkrunfw, image-builder)
      //     against the on-disk vm-tcb-manifest — digest/size/mode/symlink/
      //     group-writable checks. Throws on any mismatch.
      const verified = await sv.verifyVmTcb({
        artifactsDir: this.opts.artifactsDir,
        manifestPath: this.opts.tcbManifestPath,
      });
      // (1a) EXECUTION-PATH BINDING: the ONLY helper binary that may ever
      //     execute is the one verifyVmTcb just verified. A configured
      //     opts.helperPath that resolves (realpath) to anything other than
      //     the verified path fails closed BEFORE any exec — otherwise the
      //     BLK probe below (and later start()) would exec an unverified
      //     binary while the TCB verification covered a different file.
      const [configuredHelper, verifiedHelper] = await Promise.all([
        realpath(this.opts.helperPath).catch(() => null),
        realpath(verified.paths.helper).catch(() => null),
      ]);
      if (!configuredHelper || !verifiedHelper || configuredHelper !== verifiedHelper) {
        return {
          available: false,
          platform: this.deps.platform,
          reason: `helperPath (${this.opts.helperPath}) does not resolve to the verified TCB helper (${verified.paths.helper}) — refusing to exec an unverified binary`,
        };
      }
      // (1b) verifyGateManifest compares the gate manifest's pinned
      //     `artifacts[k]` (sha256:<hex>) refs to `loadedArtifactDigests[k]`.
      //     Thread those digests from the EXACT manifest body verifyVmTcb just
      //     verified the on-disk files against — NEVER re-read the manifest
      //     path. Between verifyVmTcb() and a second read, an attacker could
      //     swap the file so one manifest verifies the binaries while
      //     another's digests match the signed gate (verification-result
      //     substitution).
      const loadedArtifactDigests = {
        libkrun: 'sha256:' + verified.manifest.artifacts.libkrun.sha256,
        libkrunfw: 'sha256:' + verified.manifest.artifacts.libkrunfw.sha256,
        helper: 'sha256:' + verified.manifest.artifacts.helper.sha256,
        imageBuilder: 'sha256:' + verified.manifest.artifacts.imageBuilder.sha256,
      };
      // (1c) OBJECT BINDING FIRST: copy the four verified artifacts into an
      //     engine-private 0700 directory — hashing the bytes AS THEY ARE
      //     READ FOR THE COPY from a single O_NOFOLLOW fd
      //     (copyVerifiedArtifact), each digest must equal the manifest
      //     verifyVmTcb() verified — and recreate the versioned SONAME links
      //     pointing at the private copies (mirrorSonameLinks). This happens
      //     BEFORE the BLK probe so the probe (and every later phase)
      //     executes ONLY the private verified copies: a swap of the
      //     original paths after this point is irrelevant.
      const privateDir = await mkdtemp(
        path.join(this.opts.privateDirBase ?? tmpdir(), 'oct-vm-tcb-'),
      ); // mkdtemp creates 0700
      let privatePaths: VmTcbArtifacts;
      try {
        privatePaths = {
          helper: await this.copyVerifiedArtifact('helper', verified.paths.helper, verified.manifest.artifacts.helper.sha256, privateDir),
          libkrun: await this.copyVerifiedArtifact('libkrun', verified.paths.libkrun, verified.manifest.artifacts.libkrun.sha256, privateDir),
          libkrunfw: await this.copyVerifiedArtifact('libkrunfw', verified.paths.libkrunfw, verified.manifest.artifacts.libkrunfw.sha256, privateDir),
          imageBuilder: await this.copyVerifiedArtifact('imageBuilder', verified.paths.imageBuilder, verified.manifest.artifacts.imageBuilder.sha256, privateDir),
        };
        await this.mirrorSonameLinks(privateDir, privatePaths);
      } catch (err) {
        await rm(privateDir, { recursive: true, force: true }).catch(() => {});
        throw err;
      }
      // From here on, ANY exit path that does not cache the verified state
      // must discard the private dir (no half-verified private TCB left
      // behind) — the finally below is the single cleanup point.
      let cachedVerifiedState = false;
      try {
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
      // (4) Real BLK feature probe via the PRIVATE verified helper copy
      //     (step 1c), with the loader path pointed at the private dir so the
      //     verified libkrun/libkrunfw are the ones loaded. The ORIGINAL path
      //     is never executed — realpath only pins a path at check time, and
      //     executing the original would leave a realpath→exec swap window.
      //     Fail-closed: if libkrun was not built with KRUN_FEATURE_BLK, the
      //     helper exits 1.
      let blkFeature: 'present' | 'absent';
      try {
        blkFeature = (await this.probeBlkFeature(privatePaths.helper, privateDir)) ? 'present' : 'absent';
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
      // (5) Cache the fully-verified state: resolveRootfs()/assertRootfsQualified()/
      // start() consume ONLY this instance. The gate manifest here is the one
      // the release signature bound to; the TCB paths are the engine-private
      // copies of the bytes verifyVmTcb verified. A post-probe on-disk swap of
      // gate-manifest.json is invisible to the prepare/start phases (they never
      // re-read it), and swaps of the original TCB paths cannot affect the
      // private copies — "verified object" and "used object" are the same
      // inode, so there is no hash→exec TOCTOU window left to close.
      this.verifiedProbe = {
        gateManifest,
        tcbManifest: verified.manifest,
        tcbPaths: privatePaths,
        privateDir,
      };
      cachedVerifiedState = true;
      return {
        available: true,
        platform: this.deps.platform,
        gateManifest: 'verified',
        blkFeature: 'present',
        releaseManifest,
      };
      } finally {
        if (!cachedVerifiedState) {
          await rm(privateDir, { recursive: true, force: true }).catch(() => {});
        }
      }
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
    // opens the on-disk file under rootfsDir ONCE with O_RDONLY|O_NOFOLLOW and
    // hashes FROM THE OPEN FD, asserting equality with the ref — the object
    // hashed is the object kept open, so a path swap between the hash and any
    // later use is impossible by construction. The fd is then PINNED on the
    // instance: start() inherits it into the helper and the launch spec
    // references /dev/fd/N, so the attached image is the verified inode even
    // if the path is replaced afterwards. The returned artifact is STORED by
    // the backend orchestrator as its rootfsArtifact, so this MUST return a
    // real VerifiedArtifact — never throw on the success path.
    //
    // QUALIFICATION consults ONLY the probe()-cached (signature-verified) gate
    // manifest — this method never re-reads gate-manifest.json, so a
    // post-probe swap with a self-consistent but UNSIGNED gate is invisible
    // here.
    const sv = await this.sandbox();
    const v = this.requireVerifiedProbe('resolveRootfs');
    if (!sv.isRootfsQualified(v.gateManifest, ref)) {
      throw new Error(`resolveRootfs: ref not in qualifiedRootfsDigests: ${ref}`);
    }
    const absolutePath = path.join(this.opts.rootfsDir, ref);
    let fdHandle: Awaited<ReturnType<typeof open>> | undefined;
    try {
      fdHandle = await open(absolutePath, constants.O_RDONLY | constants.O_NOFOLLOW);
    } catch (err) {
      throw new Error(`resolveRootfs: cannot open rootfs file ${absolutePath}: ${err instanceof Error ? err.message : String(err)}`);
    }
    try {
      const st = await fdHandle.stat();
      const hash = createHash('sha256');
      const stream = createReadStream('', { fd: fdHandle.fd, autoClose: false });
      for await (const chunk of stream) {
        hash.update(chunk as Buffer);
      }
      const recomputed = 'sha256:' + hash.digest('hex');
      if (recomputed !== ref) {
        throw new Error(`resolveRootfs: byte digest mismatch (expected ${ref}, got ${recomputed})`);
      }
      // Replace any previously pinned rootfs fd, then pin THIS verified fd.
      await this.resolvedRootfsHandle?.close().catch(() => {});
      this.resolvedRootfsHandle = fdHandle;
      this.resolvedRootfsPath = absolutePath;
      this.resolvedRootfsRef = ref;
      fdHandle = undefined; // ownership transferred to the instance
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
    } finally {
      if (fdHandle) await fdHandle.close().catch(() => {});
    }
  }

  async assertRootfsQualified(ref: string): Promise<void> {
    // Consumes ONLY the probe()-cached (signature-verified) gate manifest —
    // never re-reads gate-manifest.json (see resolveRootfs).
    const sv = await this.sandbox();
    const v = this.requireVerifiedProbe('assertRootfsQualified');
    if (!sv.isRootfsQualified(v.gateManifest, ref)) {
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
    // Real stat seam (HI-2). Both variants stat guest executables inside the
    // VERIFIED rootfs image — the object resolveRootfs() pinned by fd after a
    // byte-digest re-check. Platform-selected, both fail-closed:
    //
    //   - Linux: loopback-mount the image read-only per call and stat the guest
    //     path (needs CAP_SYS_ADMIN, available on the privileged-Linux CI lane).
    //     Mounts from the PINNED FD via /proc/self/fd/N so the mounted image is
    //     the verified inode, not a possibly-swapped path.
    //
    //   - Darwin: macOS cannot loopback-mount ext4, so parse the image DIRECTLY
    //     via the `vm-image-builder stat` C mode (createExt4StatRootfsFile) —
    //     superblock/inode/extent/dir walk, no mount. The tool opens the PINNED
    //     FD via /dev/fd/N, so the parsed bytes are the verified inode. The
    //     executed binary is the probe-verified private copy
    //     (getVerifiedImageBuilderPath), resolved AFTER probe() succeeded.
    //
    // Any other platform throws rather than silently degrading to "all
    // executables qualified".
    let rootfsSource: string;
    let statRootfsFile: ReturnType<typeof createLoopbackStatRootfsFile>;
    if (process.platform === 'linux') {
      rootfsSource =
        this.resolvedRootfsHandle !== undefined
          ? `/proc/self/fd/${this.resolvedRootfsHandle.fd}`
          : rootfsPath;
      statRootfsFile = createLoopbackStatRootfsFile();
    } else if (process.platform === 'darwin') {
      if (this.resolvedRootfsHandle === undefined) {
        throw new Error(
          'assertExecutablesQualified: darwin ext4 stat requires the pinned rootfs fd — resolveRootfs must pin it first',
        );
      }
      rootfsSource = `/dev/fd/${this.resolvedRootfsHandle.fd}`;
      statRootfsFile = createExt4StatRootfsFile(() => this.getVerifiedImageBuilderPath());
    } else {
      throw new Error(
        `assertExecutablesQualified: no rootfs stat seam on platform ${process.platform} (fail-closed)`,
      );
    }
    await assertExecutablesQualified(ref, executables, bins, {
      rootfsPath: rootfsSource,
      statRootfsFile,
    });
  }

  async start(config: VmStartConfig): Promise<VmInstance> {
    // Contract: bootstrapArgv is exactly [<launch-spec blob>] (length 1).
    // libkrun's krun_set_exec uses bootstrapPath (exec_path) as the guest's
    // argv[0] and appends bootstrapArgv AFTER it, so the array must NOT repeat
    // bootstrapPath — otherwise the guest sees argv=[path, path, blob] and
    // vm-init reads the path (not the blob) at argv[1] → "decode/validate
    // failed". The helper execs argv[0] with argv[1] as the CBOR launch spec;
    // a malformed argv would let the guest exec an arbitrary binary, so this
    // is a security gate, not a convenience check.
    if (!Array.isArray(config.bootstrapArgv) || config.bootstrapArgv.length !== 1) {
      throw new Error(
        `bootstrapArgv must be [launchSpecBlob] (length 1); got length ${config.bootstrapArgv?.length}`,
      );
    }
    if (config.bootstrapArgv[0] === config.bootstrapPath) {
      throw new Error(
        `bootstrapArgv must not repeat bootstrapPath (${config.bootstrapPath}); libkrun supplies argv[0]`,
      );
    }
    if (config.libkrunAbi !== 'v1.19.4') {
      throw new Error(
        `unsupported libkrun ABI: ${config.libkrunAbi} (only v1.19.4 is pinned)`,
      );
    }

    // LAUNCH BINDING (fail closed). Everything executed/attached here comes
    // from the probe()-verified state — never from re-read paths:
    //   - helper: the engine-private copy probe() made of the verified helper
    //     (executed below; a post-probe swap of the original path is irrelevant)
    //   - libkrun/libkrunfw: the private copies, via *_LIBRARY_PATH=privateDir
    //   - rootfs: the fd pinned at resolveRootfs(), inherited at fd 5 and
    //     referenced as /dev/fd/5 in the launch spec — the attached image is
    //     the verified inode even if the path was swapped after resolveRootfs
    const v = this.requireVerifiedProbe('start');
    const svStart = await this.sandbox();
    if (!svStart.isRootfsQualified(v.gateManifest, config.rootfsArtifact.ref)) {
      throw new Error(`start: rootfs ref not in the probe-verified gate manifest: ${config.rootfsArtifact.ref}`);
    }
    if (
      this.resolvedRootfsHandle === undefined ||
      config.rootfsArtifact.ref !== this.resolvedRootfsRef
    ) {
      throw new Error(
        'start: rootfs fd not pinned — resolveRootfs must pin the same ref before start()',
      );
    }

    // The helper's argv[1] is the base64url(JSON) helper launch spec, NOT the
    // guest bootstrapArgv. The guest bootstrapArgv is NESTED inside the spec.
    // The spec references the rootfs via the inherited fd (/dev/fd/5), so the
    // helper's krun_add_disk opens the PINNED verified inode — not whatever
    // file the original path may now resolve to.
    const specConfig: VmStartConfig = {
      ...config,
      rootfsArtifact: {
        ...config.rootfsArtifact,
        absolutePath: `/dev/fd/${ROOTFS_INHERIT_FD}`,
      },
    };
    const helperSpecToken = buildHelperLaunchSpec(specConfig, config.trustedEnv ?? []);
    const argv = [v.tcbPaths.helper, helperSpecToken];

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
    // The pinned rootfs fd is also moved to a cloexec temp slot ≥10 so its
    // adddup2 below is a REAL dup2 (source ≠ target) that clears FD_CLOEXEC on
    // the target — the helper keeps fd 5 across exec and opens the verified
    // image via /dev/fd/5.
    const tempRootfsRead = await this.deps.dupFdCloexec(this.resolvedRootfsHandle.fd, DUPFD_MIN);
    if (tempH2gRead < DUPFD_MIN || tempG2hWrite < DUPFD_MIN || tempRootfsRead < DUPFD_MIN) {
      throw new Error(
        `F_DUPFD_CLOEXEC returned a fd below ${DUPFD_MIN} (tempH2gRead=${tempH2gRead}, tempG2hWrite=${tempG2hWrite}, tempRootfsRead=${tempRootfsRead}); R10 P1-2 source≠target invariant cannot be guaranteed`,
      );
    }
    if (tempH2gRead === tempG2hWrite || tempH2gRead === tempRootfsRead || tempG2hWrite === tempRootfsRead) {
      throw new Error(
        'F_DUPFD_CLOEXEC returned colliding temp fds for h2gRead/g2hWrite/rootfs; collision',
      );
    }

    // --- File actions installed in the helper (child) by posix_spawn. ---
    // Order matters: adddup2(tempH2gRead → 3) gives the helper its H2G read
    // end at fd 3; adddup2(tempG2hWrite → 4) gives it its G2H write end at
    // fd 4; adddup2(tempRootfsRead → 5) gives it the verified rootfs image at
    // fd 5 (the launch spec references /dev/fd/5). The temp fds themselves are
    // cloexec so they DON'T survive exec — only the dup2'd targets at 3/4/5
    // do (dup2 clears cloexec on the target).
    const fileActions: SpawnFileAction[] = [
      { kind: 'adddup2', src: tempH2gRead, target: H2G_READ_FD },
      { kind: 'adddup2', src: tempG2hWrite, target: G2H_WRITE_FD },
      { kind: 'adddup2', src: tempRootfsRead, target: ROOTFS_INHERIT_FD },
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
    // ends the helper now owns (h2gRead via temp→3, g2hWrite via temp→4, the
    // rootfs via temp→5) plus the temp slots themselves. Node RETAINS g2hRead
    // (read frames), h2gWrite (send commands), and its OWN rootfs fd — the
    // pinned verified inode stays open on the engine instance until close(),
    // so it can serve a future start() and is released by backend cleanup. ---
    const parentCloseFds = [h2gRead, g2hWrite, tempH2gRead, tempG2hWrite, tempRootfsRead];

    const libPathVar =
      this.deps.platform === 'darwin-arm64' ? 'DYLD_LIBRARY_PATH' : 'LD_LIBRARY_PATH';

    const env: NodeJS.ProcessEnv = {
      PATH: process.env.PATH ?? '',
      OCTOPUS_VSOCK_PORT: String(config.vsockPort),
      OCTOPUS_VSOCK_HOST_SOCKET: config.vsockHostSocket,
      OCTOPUS_VM_MEM_MIB: String(config.memMib),
      OCTOPUS_VM_CPUS: String(config.cpus),
    };
    // The helper links -lkrun/-lkrunfw with NO rpath (build-vm-helper.mjs
    // full-link path), and the vendored dylibs carry unversioned/bare or
    // @rpath install names — both loader search orders (Linux ld.so and macOS
    // dyld) consult *_LIBRARY_PATH BEFORE the install-name/rpath resolution.
    // Point the loader at the engine-private copies: the verified object is
    // the loaded object, and a swap of the install-dir libs is irrelevant.
    env[libPathVar] = v.privateDir;

    const raw = await this.deps.spawn(
      v.tcbPaths.helper,
      argv,
      env,
      fileActions,
      spawnAttrFlags,
      parentCloseFds,
    );

    // --- Approach A: bridge the retained control fd HERE, before
    // waitForReady(). The engine created g2hRead/h2gWrite via deps.pipe() and
    // retains them (NOT in parentCloseFds). The binding cannot bridge g2hRead
    // because the locked spawn() signature does not carry the retained fd
    // number. waitForReady() attaches data/end listeners to raw.controlRead,
    // so it MUST be a real fd-backed stream emitting the guest's
    // {"ready":true} frame — an empty PassThrough would hang until
    // readyTimeoutMs and throw (CR-5 review Critical #1). autoClose:false
    // keeps fd ownership with the VmInstance lifecycle.
    //
    // We only override when the binding tags its placeholder with
    // `__octopusNeedsEngineOverride` (the production koffi binding does this
    // for controlRead; the L1 fake returns a real working PassThrough and
    // must NOT be clobbered — its fds are fake numbers).
    //
    // raw.stdin/raw.stdout are NOT overridden: the production binding returns
    // real fd-backed streams wired to the guest's "krun-stdio" named console
    // port (workload stdin/stdout), and the L1 fake returns working
    // PassThroughs. (h2gWrite — the host->guest control input — is retained
    // for future commands but is not the workload's stdin.)
    const rawAny = raw as {
      controlRead: NodeJS.ReadableStream & { __octopusNeedsEngineOverride?: boolean };
    };
    if (rawAny.controlRead?.__octopusNeedsEngineOverride) {
      rawAny.controlRead = createReadStream('', { fd: g2hRead, autoClose: false });
    }

    // --- Capture the guest-reported workload exit code from the control
    // stream BEFORE the ready handshake. vm-init writes {"exit":N} after
    // reaping the workload child (or on a rejection: {"error":…}{"exit":127}),
    // and a fast rejection can land {"ready":true}{"error":…}{"exit":127} in a
    // SINGLE chunk. waitForReady detaches ITS onData on the ready frame, so a
    // capture attached after the handshake would miss the exit frame that
    // arrived in the same chunk — falling back to the helper's always-0 exit
    // and misreporting a rejected exec as success. Our handler coexists with
    // waitForReady's (both receive every chunk) and stays attached post-ready.
    let guestExit: number | undefined;
    let controlBuf = '';
    const onControlData = (chunk: Buffer) => {
      controlBuf += chunk.toString('utf8');
      const m = controlBuf.match(/\{"exit":(-?\d{1,5})\}/);
      if (m) guestExit = Number(m[1]);
    };
    raw.controlRead.on('data', onControlData);

    // --- Ready handshake: wait for {"ready":true} on g2hRead, or {"error":...},
    // or helper exit before ready, or readyTimeoutMs. EOF on g2hRead before
    // ready is treated as a start failure (the helper closed its write end
    // without signaling ready). ---
    //
    // Buffer the helper's EARLY stderr so a start failure (especially "closed
    // control channel before ready (EOF)", where the helper died before writing
    // any frame) carries the helper's own diagnostics — dyld/load errors, krun
    // setup failures, etc. — instead of a bare EOF. Bounded; detached on ready
    // so post-ready stderr flows only to the workload stream.
    let earlyStderr = '';
    const onEarlyStderr = (chunk: Buffer) => {
      if (earlyStderr.length < 4096) {
        earlyStderr += chunk.toString('utf8');
        if (earlyStderr.length > 4096) earlyStderr = earlyStderr.slice(0, 4096);
      }
    };
    raw.stderr.on('data', onEarlyStderr);
    const ready = await this.waitForReady(raw, config.readyTimeoutMs);
    raw.stderr.off('data', onEarlyStderr);
    if (!ready.ok) {
      // Best-effort cleanup of the half-started helper before propagating.
      try {
        await raw.kill();
      } catch {
        /* swallow — the start-failure error is the signal we care about */
      }
      const diag = earlyStderr.trim();
      throw new Error(diag ? `${ready.reason} | helper stderr: ${diag}` : ready.reason);
    }

    // --- Bridge helper stdio (fd1/fd2) + control into a VmInstance. ---
    const stdin = new PassThrough();
    const stdout = new PassThrough();
    const stderr = new PassThrough();
    raw.stdout.pipe(stdout);
    raw.stderr.pipe(stderr);
    stdin.pipe(raw.stdin);

    // The exit frame is written just before the guest halts; its pipe bytes
    // reach this stream before the helper's EOF, but the helper's exit event
    // (which resolves raw.exited) can be delivered a tick ahead of the final
    // 'data' events. Compose `exited` so it also waits — bounded — for the
    // control stream to settle (a captured frame, or EOF), so the guest's
    // reported code is never dropped to a delivery race.
    const controlSettled = new Promise<void>((resolve) => {
      if (guestExit !== undefined) return resolve();
      let done = false;
      const finish = () => { if (!done) { done = true; resolve(); } };
      const timer = setTimeout(finish, 2000);
      timer.unref?.(); // never hold the event loop on the fallback path
      const onFrame = () => { if (guestExit !== undefined) { clearTimeout(timer); finish(); } };
      raw.controlRead.on('data', onFrame);
      raw.controlRead.on('end', () => { clearTimeout(timer); finish(); });
      raw.controlRead.on('close', () => { clearTimeout(timer); finish(); });
      raw.controlRead.on('error', () => { clearTimeout(timer); finish(); });
    });
    const exited = Promise.all([raw.exited, controlSettled]).then(([status]) => (
      guestExit !== undefined ? { ...status, exitCode: guestExit } : status
    ));

    return {
      stdin,
      stdout,
      stderr,
      exited,
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
    // Release the pinned rootfs fd and the engine-private verified TCB copies.
    await this.resolvedRootfsHandle?.close().catch(() => {});
    this.resolvedRootfsHandle = undefined;
    this.resolvedRootfsPath = undefined;
    this.resolvedRootfsRef = undefined;
    if (this.verifiedProbe?.privateDir) {
      await rm(this.verifiedProbe.privateDir, { recursive: true, force: true }).catch(() => {});
    }
    this.verifiedProbe = undefined;
  }

  /**
   * The probe-verified image-builder binary path (the engine-private copy of
   * the artifact verifyVmTcb() verified). The backend/builder port MUST
   * execute this — never an independently configured path — so the executed
   * builder is the verified one (assembly binds the configured
   * builderBinaryPath to the same realpath before construction).
   */
  async getVerifiedImageBuilderPath(): Promise<string> {
    const v = this.requireVerifiedProbe('getVerifiedImageBuilderPath');
    return v.tcbPaths.imageBuilder;
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

      // Control frames are NOT newline-delimited: vm-init writes {"ready":true}
      // / {"error":...} / {"exit":N} back-to-back on the octopus-control port
      // (e.g. `{"ready":true}{"exit":0}` arrives as one chunk). Splitting on
      // '\n' never fires, so a newline-splitting reader would sit on the ready
      // frame until EOF and then mis-report a healthy boot as "closed control
      // channel before ready". Extract each complete top-level JSON object by
      // brace matching instead: take the first balanced {...} as one frame and
      // repeat on the remainder. Leading non-JSON garbage (libkrun stderr bleed)
      // up to the next '{' is counted against the malformed-frame bound (HI-4),
      // so a flooding garbage channel still fails closed. A truncated trailing
      // object stays buffered for the next chunk (or the EOF flush).
      const drainFrames = (flushPartial: boolean) => {
        for (;;) {
          const start = buf.indexOf('{');
          if (start < 0) {
            // No JSON object anywhere in the buffer: it's stderr-bleed garbage.
            // Count each newline-terminated line as its own malformed strike
            // (mirrors the per-line HI-4 contract), then keep any partial tail.
            let nl: number;
            while ((nl = buf.indexOf('\n')) >= 0) {
              const line = buf.slice(0, nl);
              buf = buf.slice(nl + 1);
              if (line.trim()) { onFrame(line); if (settled) return; }
            }
            if (flushPartial && buf.trim()) { const rest = buf; buf = ''; onFrame(rest); }
            return;
          }
          // Garbage preceding the next JSON object: strike per terminated line.
          if (start > 0) {
            const garbage = buf.slice(0, start);
            const nl = garbage.indexOf('\n');
            if (nl >= 0) {
              // A full garbage line is present → strike it, drop it, keep draining.
              const line = garbage.slice(0, nl);
              buf = buf.slice(nl + 1);
              if (line.trim()) onFrame(line);
              if (settled) return;
              continue;
            }
            // Garbage but no newline yet: the object starts right after → count
            // the (single) garbage prefix as one strike and parse the frame.
            buf = buf.slice(start);
            if (garbage.trim()) onFrame(garbage);
            if (settled) return;
          }
          let depth = 0;
          let end = -1;
          let inStr = false;
          let esc = false;
          for (let i = 0; i < buf.length; i++) {
            const c = buf[i];
            if (esc) { esc = false; continue; }
            if (c === '\\') { esc = true; continue; }
            if (c === '"') { inStr = !inStr; continue; }
            if (inStr) continue;
            if (c === '{') depth++;
            else if (c === '}') { depth--; if (depth === 0) { end = i; break; } }
          }
          if (end < 0) {
            // Incomplete trailing object: a partial frame split across chunks.
            // Buffer it and wait for the rest (or the EOF flush, which treats
            // the leftover as one final possibly-malformed frame).
            if (flushPartial && buf.trim()) { const rest = buf; buf = ''; onFrame(rest); }
            return;
          }
          const frame = buf.slice(0, end + 1);
          buf = buf.slice(end + 1);
          onFrame(frame);
          if (settled) return;
        }
      };

      const onData = (chunk: Buffer) => {
        buf += chunk.toString('utf8');
        drainFrames(false);
      };
      const onEnd = () => {
        drainFrames(true);
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
