import type { SkillMetadata, SkillInvocationPolicy } from "./types.js";

export interface ParsedSkillEntry {
  metadata: SkillMetadata;
  invocation: SkillInvocationPolicy;
}

/**
 * Per-field resolution: for each field, the flat (top-level) value wins if
 * present; the `openclaw` block is the fallback. Install arrays are NOT
 * merged per-entry — flat wins entirely if present.
 */
export function parseSkillFrontmatter(fm: Record<string, unknown>): ParsedSkillEntry {
  const oc = (fm.openclaw ?? {}) as Record<string, unknown>;

  // Per-field resolution: flat wins, openclaw is fallback
  const field = <T>(key: string): T | undefined =>
    (fm[key] !== undefined ? fm[key] : oc[key]) as T | undefined;

  const metadata: SkillMetadata = {
    always: field<boolean>("always"),
    skillKey: field<string>("skillKey"),
    primaryEnv: field<string>("primaryEnv"),
    emoji: field<string>("emoji"),
    homepage: field<string>("homepage"),
    os: field<string[]>("os"),
    requires: field<SkillMetadata["requires"]>("requires"),
    install: field<SkillMetadata["install"]>("install"),
  };

  const invocation: SkillInvocationPolicy = {
    userInvocable: fm["user-invocable"] !== false,
    disableModelInvocation: fm["disable-model-invocation"] === true,
  };

  return { metadata, invocation };
}
