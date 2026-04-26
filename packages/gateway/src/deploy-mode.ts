import { getConfig } from '@agentoctopus/core';

export type DeployMode = 'cloud' | 'local';

export function getDeployMode(): DeployMode {
  return getConfig().deploy.mode;
}

export function isCloudMode(): boolean {
  return getDeployMode() === 'cloud';
}

export function isLocalMode(): boolean {
  return getDeployMode() === 'local';
}
