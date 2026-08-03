import type { SkillInstallSpec } from "./types.js";

/**
 * Sanitize a user-supplied string for use in operator-facing instruction text.
 * Rejects dangerous inputs — leading dashes, path traversal sequences.
 */
export function sanitizeString(input: string): string {
  if (/^[-]/.test(input))
    throw new Error(`Invalid input: starts with dash: "${input}"`);
  if (/\\/.test(input) || input.includes(".."))
    throw new Error(`Invalid input: path traversal: "${input}"`);
  return input;
}

/**
 * Generate a human-readable, operator-facing description of the manual step a
 * spec would require. This is informational text ONLY — it is never executed.
 * Skills are untrusted and must never trigger host package-manager execution;
 * the operator uses this to know which trusted runtime profile is missing.
 */
export function generateManualInstruction(spec: SkillInstallSpec): string {
  switch (spec.kind) {
    case "brew":
      return `brew install ${spec.formula ?? spec.package ?? "<formula>"}`;
    case "node":
      return `npm install -g ${spec.package ?? "<package>"}`;
    case "go":
      return `go install ${spec.module ?? "<module>"}`;
    case "uv":
      return `uv tool install ${spec.package ?? "<package>"}`;
    case "download":
      return `curl -L "${spec.url ?? "<url>"}" -o <file>`;
    default:
      return "";
  }
}
