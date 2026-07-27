import type { SandboxSkillDescriptor, ResourceRequest, ResolvedResources } from './types.js';
import type { SandboxConfig, CredentialGrant } from './schema.js';
import { hostMatches } from './host-match.js';

/** Effective, resolved policy for one execution: requested ∩ granted (spec §4). */
export interface SandboxPolicy {
  hosts: string[];
  credentials: CredentialGrant[];
  resources: ResolvedResources;
  denied: { hosts: string[]; credentials: string[] };
}

const BYTE_UNITS: Record<string, number> = {
  b: 1,
  k: 1024,
  kb: 1024,
  m: 1024 ** 2,
  mb: 1024 ** 2,
  g: 1024 ** 3,
  gb: 1024 ** 3,
};

/** Parse a positive byte quantity such as 16m into an integer byte count. */
export function parseByteSize(value: string): number {
  const match = /^([0-9]+(?:\.[0-9]+)?)(b|k|kb|m|mb|g|gb)$/i.exec(value.trim());
  if (!match) throw new Error(`invalid byte size: ${value}`);
  const bytes = Number(match[1]) * BYTE_UNITS[match[2]!.toLowerCase()]!;
  if (!Number.isSafeInteger(bytes) || bytes <= 0) throw new Error(`invalid byte size: ${value}`);
  return bytes;
}

/** Parse a positive finite CPU count such as 0.5. */
export function parseCpuCount(value: string): number {
  const cpus = Number(value);
  if (!Number.isFinite(cpus) || cpus <= 0) throw new Error(`invalid CPU count: ${value}`);
  return cpus;
}

/** Accept only a positive safe-integer timeout. */
export function parseTimeoutMs(value: number): number {
  if (!Number.isSafeInteger(value) || value <= 0) throw new Error(`invalid timeout: ${value}`);
  return value;
}

/**
 * Parse untrusted resource requests and clamp them component-wise to trusted
 * caps. Invalid trusted caps or invalid requests throw before backend prepare().
 */
export function clampResources(request: ResourceRequest | undefined, caps: ResourceRequest): ResolvedResources {
  if (caps.memory === undefined) throw new Error('trusted memory cap missing');
  if (caps.timeoutMs === undefined) throw new Error('trusted timeout cap missing');
  if (caps.cpus === undefined) throw new Error('trusted CPU cap missing');
  const capMemory = parseByteSize(caps.memory);
  const capTimeout = parseTimeoutMs(caps.timeoutMs);
  const capCpus = parseCpuCount(caps.cpus);
  const requestedMemory = request?.memory === undefined ? undefined : parseByteSize(request.memory);
  const requestedTimeout = request?.timeoutMs === undefined ? undefined : parseTimeoutMs(request.timeoutMs);
  const requestedCpus = request?.cpus === undefined ? undefined : parseCpuCount(request.cpus);

  return {
    memoryBytes: requestedMemory === undefined ? capMemory : Math.min(requestedMemory, capMemory),
    timeoutMs: requestedTimeout === undefined ? capTimeout : Math.min(requestedTimeout, capTimeout),
    cpus: requestedCpus === undefined ? capCpus : Math.min(requestedCpus, capCpus),
  };
}

/**
 * Resolve the effective policy. Grants are looked up by installationId+digest —
 * never by skill name. A stale digest (content changed) yields empty grants.
 */
export function resolvePolicy(descriptor: SandboxSkillDescriptor, config: SandboxConfig): SandboxPolicy {
  const { identity, request } = descriptor;
  const grant = (config.grants ?? []).find(
    g => g.installationId === identity.installationId && g.digest === identity.digest,
  );

  const grantedHosts = grant?.hosts ?? [];
  const requestedHosts = request.hosts ?? [];
  const hosts: string[] = [];
  const deniedHosts: string[] = [];
  for (const requestedHost of requestedHosts) {
    if (grantedHosts.some(grantPattern => hostMatches(grantPattern, requestedHost))) hosts.push(requestedHost);
    else deniedHosts.push(requestedHost);
  }

  const requestedCreds = new Set(request.credentials ?? []);
  const credentials: CredentialGrant[] = (grant?.credentials ?? []).filter(c => requestedCreds.has(c.key));
  const grantedCredKeys = new Set((grant?.credentials ?? []).map(c => c.key));
  const deniedCreds = [...requestedCreds].filter(k => !grantedCredKeys.has(k));

  const resources = clampResources(request.resources, {
    memory: config.defaults.memory,
    timeoutMs: config.defaults.timeoutMs,
    cpus: config.defaults.cpus,
  });

  return { hosts, credentials, resources, denied: { hosts: deniedHosts, credentials: deniedCreds } };
}
