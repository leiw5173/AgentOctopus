import { z } from 'zod';
export const AuthSchema = z.enum(['none', 'api_key', 'oauth', 'bearer']);
export const AdapterSchema = z.enum(['http', 'mcp', 'subprocess', 'openai']);
export const HostingSchema = z.enum(['cloud', 'local', 'both']);
export const SkillManifestSchema = z.object({
    name: z.string(),
    description: z.string(),
    tags: z.array(z.string()).default([]),
    version: z.string().default('1.0.0'),
    endpoint: z.string().optional(),
    adapter: AdapterSchema.default('http'),
    hosting: HostingSchema.default('cloud'),
    auth: AuthSchema.default('none'),
    input_schema: z.record(z.string()).optional(),
    output_schema: z.record(z.string()).optional(),
    rating: z.number().min(0).max(5).default(3.0),
    invocations: z.number().int().min(0).default(0),
    enabled: z.boolean().default(true),
    // optional LLM-based skill (no endpoint, uses system LLM)
    llm_powered: z.boolean().default(false),
});
//# sourceMappingURL=manifest-schema.js.map