/**
 * Core domain DTOs for the sandbox. This package is a leaf: these types must
 * not reference registry/core/adapters types. Callers translate their own
 * skill representations into these DTOs at the boundary (spec §3).
 */

export type IsolationLevel = 'full' | 'restricted' | 'remote-unverified' | 'none';

export type BackendKind = 'docker' | 'os' | 'subprocess' | 'ssh' | 'none';

/** Stable, host-owned identity for one installed skill (spec §4). */
export interface InstallationIdentity {
  /** Immutable, host-generated uuid assigned at install time. */
  installationId: string;
  /** sha256 over the canonical snapshot manifest; grant key. */
  digest: string;
  /** Content-addressed pointer to the immutable execution snapshot. */
  snapshotRef: string;
  /** Provenance for display/policy grouping only — never a grant key. */
  source?: { publisher?: string; repo?: string; ref?: string };
  /** Untrusted display name — NOT a grant key. */
  name: string;
}

/** What an untrusted skill requests (never grants anything by itself). */
export interface ResourceRequest {
  memory?: string;
  timeoutMs?: number;
  cpus?: string;
}

/** Parsed resource values after untrusted requests are clamped to trusted caps. */
export interface ResolvedResources {
  memoryBytes: number;
  timeoutMs: number;
  cpus: number;
}

export interface SandboxRequest {
  hosts?: string[];
  credentials?: string[];
  bins?: string[];
  resources?: ResourceRequest;
}

/**
 * The only skill representation this package accepts. Produced by callers from
 * their LoadedSkill at the package boundary.
 */
export interface SandboxSkillDescriptor {
  identity: InstallationIdentity;
  /** Absolute path to the immutable snapshot root to mount (never the live dir). */
  snapshotRoot: string;
  request: SandboxRequest;
}

/** Machine-readable isolation outcome attached to every execution result. */
export interface SandboxResultMeta {
  isolationLevel: IsolationLevel;
  backend: BackendKind;
  degraded: boolean;
  degradationReasons: string[];
}
