import type { VmStartConfig } from '@agentoctopus/sandbox';

export interface HelperLaunchSpec {
  rootfsPath: string;
  skillBlockPath: string;
  caBlockPath: string;
  vsockPort: number;
  vsockHostSocket: string;
  cpus: number;
  memMib: number;
  bootstrapPath: string;
  bootstrapArgv: string[];
  trustedEnv: string[];
}

const ABS = (p: string) => p.startsWith('/');
const NO_DOTDOT = (p: string) => !p.includes('..');
const NO_NUL = (p: string) => !p.includes('\0');

function assertPathField(name: string, p: string): void {
  if (typeof p !== 'string' || !ABS(p)) throw new Error(`helper spec: ${name} must be absolute`);
  if (!NO_DOTDOT(p)) throw new Error(`helper spec: ${name} must not contain '..'`);
  if (!NO_NUL(p)) throw new Error(`helper spec: ${name} must not contain NUL`);
}

export function buildHelperLaunchSpec(config: VmStartConfig, trustedEnv: string[] = []): string {
  assertPathField('rootfsPath', config.rootfsArtifact.absolutePath);
  assertPathField('skillBlockPath', config.skillBlockImage.absolutePath);
  assertPathField('caBlockPath', config.caBlockImage.absolutePath);
  assertPathField('vsockHostSocket', config.vsockHostSocket);
  assertPathField('bootstrapPath', config.bootstrapPath);
  if (config.vsockPort === 0 || !Number.isInteger(config.vsockPort) || config.vsockPort < 0 || config.vsockPort > 0xffffffff)
    throw new Error(`helper spec: vsockPort out of range (${config.vsockPort})`);
  if (!Array.isArray(config.bootstrapArgv) || config.bootstrapArgv.length !== 2)
    throw new Error('helper spec: bootstrapArgv must have exactly 2 entries');
  if (config.bootstrapArgv[0] !== config.bootstrapPath)
    throw new Error('helper spec: bootstrapArgv[0] must equal bootstrapPath');
  for (const s of [config.bootstrapPath, ...config.bootstrapArgv, ...trustedEnv]) {
    if (typeof s !== 'string' || !NO_NUL(s)) throw new Error('helper spec: NUL byte in string field');
  }
  const spec: HelperLaunchSpec = {
    rootfsPath: config.rootfsArtifact.absolutePath,
    skillBlockPath: config.skillBlockImage.absolutePath,
    caBlockPath: config.caBlockImage.absolutePath,
    vsockPort: config.vsockPort,
    vsockHostSocket: config.vsockHostSocket,
    cpus: config.cpus,
    memMib: config.memMib,
    bootstrapPath: config.bootstrapPath,
    bootstrapArgv: config.bootstrapArgv,
    trustedEnv,
  };
  return Buffer.from(JSON.stringify(spec), 'utf8').toString('base64url');
}
