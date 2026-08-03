import path from 'node:path';
import os from 'node:os';
import { getConfig } from '@agentoctopus/core';
import { lookupInstallationId } from '@agentoctopus/skills';
import { IMMUTABLE_IMAGE_RE } from '@agentoctopus/sandbox';

export interface DoctorCheck { name: string; ok: boolean; detail: string; }
export interface DoctorReport { ok: boolean; report: DoctorCheck[]; }

export async function runDoctor(): Promise<DoctorReport> {
  const cfg = getConfig();
  const checks: DoctorCheck[] = [];

  const nodeProfile = cfg.sandbox.runtimeProfiles?.['node'];
  checks.push({
    name: 'runtimeProfiles.node covers node bin',
    ok: !!nodeProfile && Array.isArray(nodeProfile.bins) && nodeProfile.bins.includes('node'),
    detail: nodeProfile ? `bins=[${(nodeProfile.bins ?? []).join(', ')}]` : 'sandbox.runtimeProfiles.node missing',
  });

  const dockerImage = cfg.sandbox.docker?.image ?? '';
  checks.push({
    name: 'sandbox.docker.image immutable',
    ok: IMMUTABLE_IMAGE_RE.test(dockerImage),
    detail: dockerImage || 'sandbox.docker.image unset',
  });

  const proxyArtifact = cfg.sandbox.proxy?.artifact ?? '';
  checks.push({
    name: 'sandbox.proxy.artifact immutable',
    ok: IMMUTABLE_IMAGE_RE.test(proxyArtifact),
    detail: proxyArtifact || 'sandbox.proxy.artifact unset',
  });

  checks.push({
    name: 'backend fail-closed (docker + full)',
    ok: cfg.sandbox.defaultBackend === 'docker' && cfg.sandbox.minIsolationLevel === 'full',
    detail: `defaultBackend=${cfg.sandbox.defaultBackend} minIsolationLevel=${cfg.sandbox.minIsolationLevel}`,
  });

  const weatherDir = path.join(os.homedir(), '.agentoctopus', 'skills', 'weather');
  let installOk = false;
  let installDetail = 'not installed (~/.agentoctopus/skills/weather)';
  try {
    installOk = !!lookupInstallationId(weatherDir);
    installDetail = installOk ? 'installationId present' : 'no installationId';
  } catch (err) {
    installDetail = `missing installationId: ${(err as Error).message}`;
  }
  checks.push({ name: 'weather skill installed with installationId', ok: installOk, detail: installDetail });

  return { ok: checks.every(c => c.ok), report: checks };
}
