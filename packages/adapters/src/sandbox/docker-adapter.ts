import { spawn } from 'node:child_process';
import path from 'path';
import type { LoadedSkill } from '@agentoctopus/registry';
import type { Adapter, AdapterResult } from '../adapter.js';

export interface DockerAdapterOptions {
  image?: string;
  memory?: string;
  network?: 'bridge' | 'none' | 'host';
  timeoutMs?: number;
}

const SANDBOX_PASSTHROUGH_VARS = ['PATH', 'HOME', 'TMPDIR', 'TEMP', 'TMP', 'LANG', 'TZ', 'TERM'];

/**
 * Docker sandbox adapter: runs skill inside a Docker container.
 * Mounts the skill directory read-only; passes env vars; captures stdout/stderr.
 */
export class DockerAdapter implements Adapter {
  constructor(private options: DockerAdapterOptions = {}) {}

  async invoke(skill: LoadedSkill, input: Record<string, unknown>): Promise<AdapterResult> {
    const image = this.options.image ?? 'node:20-alpine';
    const memory = this.options.memory ?? '512m';
    const network = this.options.network ?? 'none';
    const timeoutMs = this.options.timeoutMs ?? 30000;

    const skillDir = skill.dirPath;
    const dirName = path.basename(skillDir);

    // Build env var flags
    const envFlags: string[] = [];
    for (const key of SANDBOX_PASSTHROUGH_VARS) {
      if (process.env[key] !== undefined) {
        envFlags.push('-e', `${key}=${process.env[key]}`);
      }
    }

    // Pass OCTOPUS_INPUT
    envFlags.push('-e', `OCTOPUS_INPUT=${JSON.stringify(input)}`);

    // Build docker run command
    const args = [
      'run', '--rm',
      '--network', network,
      '--memory', memory,
      '-v', `${skillDir}:/skill/${dirName}:ro`,
      '-w', `/skill/${dirName}`,
      ...envFlags,
      image,
      'sh', '-c',
      'if [ -f scripts/invoke.js ]; then node scripts/invoke.js; elif [ -f scripts/invoke.py ]; then python3 scripts/invoke.py; else echo "No invoke script found"; fi',
    ];

    return new Promise((resolve) => {
      const child = spawn('docker', args, {
        stdio: ['pipe', 'pipe', 'pipe'],
      });

      const killTimer = setTimeout(() => {
        child.kill('SIGTERM');
        resolve({ success: false, error: `Docker sandbox timed out after ${timeoutMs}ms` });
      }, timeoutMs);

      let stdout = '';
      let stderr = '';

      child.stdout.on('data', (d: Buffer) => { stdout += d.toString(); });
      child.stderr.on('data', (d: Buffer) => { stderr += d.toString(); });

      child.on('close', (code: number) => {
        clearTimeout(killTimer);
        if (code !== 0) {
          resolve({ success: false, error: stderr || `Docker exited with code ${code}` });
        } else {
          resolve({ success: true, rawText: stdout });
        }
      });

      child.on('error', (err: Error) => {
        clearTimeout(killTimer);
        resolve({ success: false, error: err.message });
      });

      child.stdin.end();
    });
  }
}
