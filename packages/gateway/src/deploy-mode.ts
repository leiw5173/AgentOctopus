/**
 * Deployment mode helpers.
 *
 * DEPLOY_MODE=cloud  → full gateway + web UI, exposes skill export
 * DEPLOY_MODE=local  → gateway only, can sync skills from cloud (default)
 */

export type DeployMode = 'cloud' | 'local';

export function getDeployMode(): DeployMode {
  const mode = process.env.DEPLOY_MODE?.toLowerCase();
  return mode === 'cloud' ? 'cloud' : 'local';
}

export function isCloudMode(): boolean {
  return getDeployMode() === 'cloud';
}

export function isLocalMode(): boolean {
  return getDeployMode() === 'local';
}
