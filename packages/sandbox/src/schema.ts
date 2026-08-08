import { z } from 'zod';

/**
 * Canonical sandbox schemas (spec §11): the single source of truth that
 * skills/registry/core import instead of defining their own `sandbox` blocks.
 * Plan 5 must NOT redefine these — it references `@agentoctopus/sandbox` only.
 */

/** Untrusted SKILL.md `sandbox.request` block — requests only, grants nothing. */
export const SandboxRequestSchema = z
  .object({
    hosts: z.array(z.string()).optional(),
    credentials: z.array(z.string()).optional(),
    bins: z.array(z.string()).optional(), // requested binaries the skill wants available
    resources: z
      .object({
        memory: z.string().optional(),
        timeoutMs: z.number().int().positive().optional(),
        cpus: z.string().optional(),
      })
      .optional(),
  })
  .strict();
export type SandboxRequestInput = z.infer<typeof SandboxRequestSchema>;

/** Trusted credential grant. Scope comes ONLY from here, never from the skill. */
export const CredentialGrantSchema = z
  .object({
    key: z.string().regex(/^[A-Z][A-Z0-9_]*$/, 'credential key must be an env-var name'),
    host: z.string(),
    port: z.number().int().positive(),
    scheme: z.enum(['http', 'https']),
    methods: z.array(z.string()).nonempty(),
    pathPrefix: z.string(),
    header: z.string(),
    prefix: z.string().optional(),
    highRisk: z.boolean().optional(),
  })
  .strict();
export type CredentialGrant = z.infer<typeof CredentialGrantSchema>;

/** Trusted grant keyed by stable installation identity (installationId+digest). */
export const InstallationGrantSchema = z
  .object({
    installationId: z.string(),
    digest: z.string(),
    hosts: z.array(z.string()).optional(),
    credentials: z.array(CredentialGrantSchema).optional(),
  })
  .strict();
export type InstallationGrant = z.infer<typeof InstallationGrantSchema>;

/**
 * Docker images are immutable only when addressed by a full sha256 digest.
 * Accepts either `name@sha256:<64 hex>` (a registry image) or a bare local
 * content ID `sha256:<64 hex>` (what `docker image inspect --format '{{.Id}}'`
 * emits, used by the release security lane). Mutable tags like `repo:latest`
 * are rejected.
 *
 * This regex is the SINGLE source of truth for the immutable-image gate. The
 * security harness (`tests/security/harness.ts` `requirePinnedImageRef`) and
 * `ImmutableImageRefSchema` both use it so the harness can never be looser or
 * stricter than the production schema. Lowercase only — no `i` flag — so an
 * uppercase repo/digest the schema rejects is also rejected by the harness.
 */
export const IMMUTABLE_IMAGE_RE =
  /^(?:[a-z0-9]+(?:[._-][a-z0-9]+)*(?::[0-9]+)?(?:\/[a-z0-9]+(?:[._-][a-z0-9]+)*)*@)?sha256:[0-9a-f]{64}$/;

export const ImmutableImageRefSchema = z.string().regex(
  IMMUTABLE_IMAGE_RE,
  'docker image must use immutable name@sha256:<64 lowercase hex> or sha256:<64 lowercase hex> syntax',
);

/**
 * Content-addressed snapshot digest. The snapshot store produces
 * `sha256:<64 lowercase hex>` (see snapshot.ts `canonicalDigest`), and this
 * regex is the single source of truth for validating a digest handed to a
 * backend as `BackendPrepareOptions.expectedSnapshotDigest`. Lowercase only —
 * no `i` flag — so an uppercase digest the producer never emits is also
 * rejected at the consumer.
 */
export const SNAPSHOT_DIGEST_RE = /^sha256:[0-9a-f]{64}$/;

/**
 * Trusted `octopus.json` `sandbox` section. `.strict()` rejects unknown fields
 * so legacy/malformed config is rejected rather than silently dropped.
 */
export const SandboxConfigSchema = z
  .object({
    defaultBackend: z.enum(['auto', 'docker', 'os', 'windows', 'vm', 'subprocess', 'ssh', 'none']).default('auto'),
    minIsolationLevel: z.enum(['full', 'restricted', 'remote-unverified', 'none']).default('full'),
    runtimeProfiles: z
      .record(
        z.string(),
        z.object({
          bins: z.array(z.string()).default([]),
          path: z.string(),
          dockerImage: ImmutableImageRefSchema.optional(),
          osRuntime: z
            .object({
              artifactPath: z.string(),
              manifestPath: z.string(),
              nodePath: z.enum(['/usr/bin/node', '/bin/node', '/usr/local/bin/node']),
            })
            .optional(),
          /**
           * Trusted Darwin restricted-runtime identity. `manifestPath` is the
           * host path of the verified macOS Node runtime closure manifest
           * (T5 audits the closure; T7/T10 consume it). `.strict()` rejects
           * unknown nested fields so a typo cannot silently weaken the gate.
           */
          darwinRuntime: z
            .object({ manifestPath: z.string() })
            .strict()
            .optional(),
          /**
           * Trusted Windows restricted-runtime identity. `manifestPath` is
           * the host path of the verified Windows runtime closure manifest
           * (Node exe + bootstrap.cjs + vendored undici). `.strict()`
           * rejects unknown nested fields so a typo cannot silently weaken
           * the gate.
           */
          windowsRuntime: z
            .object({
              manifestPath: z.string(),
              nodePath: z.string(),
              bootstrapPath: z.string(),
            })
            .strict()
            .optional(),
          vmRuntime: z
            .object({
              rootfs: ImmutableImageRefSchema,
              memMib: z.number().int().positive().max(4096).default(512),
              cpus: z.number().int().positive().max(4).default(1),
              kernelCmdline: z.string().optional(),
              executables: z.record(z.string(), z.string()),
            })
            .strict()
            .optional(),
        }),
      )
      .default({}),
    docker: z
      .object({
        image: ImmutableImageRefSchema,
        memory: z.string().default('512m'),
        cpus: z.string().default('0.5'),
        pids: z.number().int().positive().default(64),
        ulimits: z
          .object({
            nofile: z.number().int().positive().default(256),
            fsize: z.string().default('32m'),
          })
          .prefault({}), // Zod v4: input-typed default; `.default({})` rejects missing output fields
      })
      .optional(),
    vm: z
      .object({
        rootfs: ImmutableImageRefSchema,
        memMib: z.number().int().positive().max(4096).default(512),
        cpus: z.number().int().positive().max(4).default(1),
        kernelCmdline: z.string().optional(),
        libkrunAbi: z.literal('v1.19.4').default('v1.19.4'),
        // Paths to the verified TCB artifacts. When unset, createVmBackend
        // resolves documented defaults under prebuilds/<platform>/.
        helperPath: z.string().optional(),
        artifactsDir: z.string().optional(),
        tcbManifestPath: z.string().optional(),
        gateManifestPath: z.string().optional(),
        releaseManifestPath: z.string().optional(),
        releaseManifestSignaturePath: z.string().optional(),
        rootfsDir: z.string().optional(),
        builderBinaryPath: z.string().optional(),
      })
      .optional(),
    proxy: z
      .object({
        // Digest-pinned proxy artifact (image or binary). Validated with the
        // same immutable-reference regex as docker.image so a mutable tag
        // (e.g. `proxy:latest`) is rejected during config parsing.
        artifact: ImmutableImageRefSchema,
        maxReqBytes: z.number().int().positive().default(1_048_576),
        maxRespBytes: z.number().int().positive().default(10_485_760),
        maxConns: z.number().int().positive().default(32),
      })
      .optional(),
    defaults: z
      .object({
        memory: z.string().default('512m'),
        timeoutMs: z.number().int().positive().default(30_000),
        cpus: z.string().default('0.5'),
        outputMaxBytes: z.number().int().positive().default(1_048_576),
      })
      .prefault({}), // Zod v4: run inner defaults from an empty input object
    grants: z.array(InstallationGrantSchema).default([]),
  })
  .strict();
export type SandboxConfig = z.infer<typeof SandboxConfigSchema>;
