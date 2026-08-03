import { z } from "zod";
import { SandboxRequestSchema } from "@agentoctopus/sandbox";

// Sub-schemas
const SkillRequiresSchema = z.object({
  bins: z.array(z.string()).optional(),
  anyBins: z.array(z.string()).optional(),
  env: z.array(z.string()).optional(),
  config: z.array(z.string()).optional(),
});

const SkillInstallSpecSchema = z.object({
  id: z.string().optional(),
  label: z.string().optional(),
  bins: z.array(z.string()).optional(),
  kind: z.enum(["brew", "node", "go", "uv", "download"]),
  os: z.array(z.string()).optional(),
  formula: z.string().optional(),
  package: z.string().optional(),
  module: z.string().optional(),
  url: z.string().optional(),
  archive: z.string().optional(),
  extract: z.boolean().optional(),
  stripComponents: z.number().int().nonnegative().optional(),
  targetDir: z.string().optional(),
});

// OpenClaw block (nested under openclaw: key)
const OpenClawBlockSchema = z.object({
  skillKey: z.string().optional(),
  primaryEnv: z.string().optional(),
  always: z.boolean().optional(),
  os: z.array(z.string()).optional(),
  emoji: z.string().optional(),
  homepage: z.string().optional(),
  requires: SkillRequiresSchema.optional(),
  install: z.array(SkillInstallSpecSchema).optional(),
}).passthrough();

// Top-level schema — both flat fields and openclaw block accepted
export const SkillFrontmatterSchema = z.object({
  name: z.string(),
  description: z.string(),
  version: z.string().optional(),
  emoji: z.string().optional(),
  homepage: z.string().optional(),
  os: z.array(z.string()).optional(),
  primaryEnv: z.string().optional(),
  always: z.boolean().optional(),
  requires: SkillRequiresSchema.optional(),
  install: z.array(SkillInstallSpecSchema).optional(),
  "user-invocable": z.boolean().optional(),
  "disable-model-invocation": z.boolean().optional(),
  "command-dispatch": z.string().optional(),
  "command-tool": z.string().optional(),
  "command-arg-mode": z.string().optional(),
  adapter: z.enum(["http", "mcp", "subprocess", "openai", "composed"]).optional(),
  // Untrusted sandbox block — requests only, owned by @agentoctopus/sandbox.
  // Trusted config/grants live in octopus.json, never here.
  sandbox: SandboxRequestSchema.optional(),
  compose: z.object({
    steps: z.array(z.object({
      skill: z.string(),
      inputMapping: z.record(z.string(), z.string()).optional(),
      outputAs: z.string().optional(),
      condition: z.string().optional(),
    })),
  }).optional(),
  openclaw: OpenClawBlockSchema.optional(),
}).passthrough();

// Inferred type
export type SkillFrontmatter = z.infer<typeof SkillFrontmatterSchema>;
