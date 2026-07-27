/**
 * Boundary translation (spec §11): registry LoadedSkill → sandbox DTO.
 *
 * The sandbox package is a leaf and only accepts `SandboxSkillDescriptor`.
 * This module is the one place where we translate a `LoadedSkill` into that
 * shape. Request-side ONLY: we collect key names, hosts, and bins the skill
 * ASKS for. Trusted grants are keyed by `installationId + digest` and live in
 * octopus.json — we never derive grants from a manifest, and the skill's
 * `name` is untrusted display only.
 */
import type { LoadedSkill } from '@agentoctopus/registry';
import { getSkillEntry } from '@agentoctopus/registry';
import type { SandboxSkillDescriptor } from '@agentoctopus/sandbox';

/** Request-only credential side: key names only; scope comes from trusted grants. */
export function requestedCredentials(skill: LoadedSkill): string[] {
  const keys = new Set<string>(skill.manifest.sandbox?.credentials ?? []);
  for (const c of (skill.manifest.credentials ?? []) as Array<{ key: string }>) keys.add(c.key);
  const ocEnv = (skill.manifest.metadata as any)?.openclaw?.env;
  if (Array.isArray(ocEnv)) for (const k of ocEnv) if (typeof k === 'string') keys.add(k);
  return [...keys];
}

/** Request-only host side: explicit declarations plus instruction URLs. */
export function requestedHosts(skill: LoadedSkill, instructions: string): string[] {
  const hosts = new Set<string>(skill.manifest.sandbox?.hosts ?? []);
  for (const m of instructions.matchAll(/https?:\/\/([^/\s:]+)/g)) hosts.add(m[1]!.toLowerCase());
  return [...hosts];
}

/** Request-only binaries; resolution is against trusted runtime profiles. */
export function requestedBins(skill: LoadedSkill): string[] {
  const manifest = skill.manifest as unknown as {
    sandbox?: { bins?: string[] };
    requires?: { bins?: string[] };
  };
  return [...new Set([
    ...(manifest.sandbox?.bins ?? []),
    ...(manifest.requires?.bins ?? []),
  ])];
}

/**
 * Boundary translation (spec §11): registry LoadedSkill → sandbox DTO.
 * Grant keys are installationId + digest; the skill name is untrusted display.
 */
export function toSandboxDescriptor(
  skill: LoadedSkill,
  opts: { snapshotRoot: string; digest: string; installationId: string },
): SandboxSkillDescriptor {
  const instructions = getSkillEntry(skill).skill.instructions;
  return {
    identity: {
      installationId: opts.installationId,
      digest: opts.digest,
      snapshotRef: opts.digest,
      name: skill.manifest.name,
    },
    snapshotRoot: opts.snapshotRoot,
    request: {
      credentials: requestedCredentials(skill),
      hosts: requestedHosts(skill, instructions),
      bins: requestedBins(skill),
    },
  };
}
