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
 */
export const ImmutableImageRefSchema = z.string().regex(
  /^(?:[a-z0-9]+(?:[._-][a-z0-9]+)*(?::[0-9]+)?(?:\/[a-z0-9]+(?:[._-][a-z0-9]+)*)*@)?sha256:[0-9a-f]{64}$/,
  'docker image must use immutable name@sha256:<64 lowercase hex> or sha256:<64 lowercase hex> syntax',
);

/**
 * Trusted `octopus.json` `sandbox` section. `.strict()` rejects unknown fields
 * so legacy/malformed config is rejected rather than silently dropped.
 */
export const SandboxConfigSchema = z
  .object({
    defaultBackend: z.enum(['auto', 'docker', 'os', 'subprocess', 'ssh', 'none']).default('auto'),
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
    proxy: z
      .object({
        artifact: z.string(), // digest-pinned proxy artifact (image or binary)
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
