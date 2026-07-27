import { spawn } from 'node:child_process';

export class DockerCliError extends Error {
  constructor(message: string, readonly stderr: string) { super(message); this.name = 'DockerCliError'; }
}

export interface DockerRunOut { stdout: string; stderr: string; code: number; }

/** Spawn `docker` with args; resolve with output + exit code. Throw only on spawn error/timeout. */
export function runDocker(args: string[], opts: { input?: string; timeoutMs?: number } = {}): Promise<DockerRunOut> {
  const timeoutMs = opts.timeoutMs ?? 60_000;
  return new Promise((resolve, reject) => {
    let child;
    try {
      child = spawn('docker', args, { stdio: ['pipe', 'pipe', 'pipe'] });
    } catch (err) {
      reject(new DockerCliError(`failed to spawn docker: ${String(err)}`, ''));
      return;
    }
    let stdout = '';
    let stderr = '';
    const timer = setTimeout(() => {
      child.kill('SIGKILL');
      reject(new DockerCliError(`docker ${args[0]} timed out after ${timeoutMs}ms`, stderr));
    }, timeoutMs);
    child.stdout.on('data', (d) => { stdout += d.toString(); });
    child.stderr.on('data', (d) => { stderr += d.toString(); });
    child.on('error', (err) => { clearTimeout(timer); reject(new DockerCliError(err.message, stderr)); });
    child.on('close', (code) => { clearTimeout(timer); resolve({ stdout, stderr, code: code ?? -1 }); });
    if (opts.input !== undefined) { child.stdin.write(opts.input); }
    child.stdin.end();
  });
}

/** True iff docker binary exists and the daemon responds. Never throws. */
export async function dockerAvailable(): Promise<boolean> {
  try {
    const res = await runDocker(['info', '--format', '{{.ServerVersion}}'], { timeoutMs: 10_000 });
    return res.code === 0 && res.stdout.trim().length > 0;
  } catch {
    return false;
  }
}
