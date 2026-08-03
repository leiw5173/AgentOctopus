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

/**
 * Wait until a freshly `docker run`-ed container reports State.Running.
 *
 * `docker run` returns control to the caller before the daemon has registered
 * the container as running, so an immediate follow-up (`docker network
 * connect`, `docker exec`, `docker top`) can race the daemon and fail with
 * "No such container". Poll the container state until it is running.
 *
 * Throws if the container exits before reaching the running state (a genuine
 * startup failure, surfaced with its exit code) or if it does not become
 * running within `timeoutMs`.
 */
export async function waitForContainerRunning(name: string, timeoutMs = 15_000): Promise<void> {
  const deadline = Date.now() + timeoutMs;
  for (;;) {
    const res = await runDocker(['inspect', '--format', '{{.State.Status}} {{.State.ExitCode}}', name], { timeoutMs: 10_000 });
    if (res.code === 0) {
      const [status, exitCode] = res.stdout.trim().split(/\s+/);
      if (status === 'running') return;
      if (status === 'exited' || status === 'dead') {
        throw new DockerCliError(`container ${name} exited before running (exit ${exitCode ?? '?'})`, res.stdout);
      }
    }
    // res.code !== 0 => container not yet visible to the daemon; keep polling.
    if (Date.now() > deadline) {
      throw new DockerCliError(`container ${name} did not reach running state within ${timeoutMs}ms`, '');
    }
    await new Promise((r) => setTimeout(r, 25));
  }
}
