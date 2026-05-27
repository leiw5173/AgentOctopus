import { spawn } from 'node:child_process';
import path from 'path';
import type { LoadedSkill } from '@agentoctopus/registry';
import type { Adapter, AdapterResult } from '../adapter.js';

export interface SshAdapterOptions {
  host: string;
  user: string;
  keyPath?: string;
  remoteSkillDir?: string;
  timeoutMs?: number;
}

/**
 * SSH sandbox adapter: executes skill on a remote host via SSH.
 * Assumes the skill directory is already present on the remote host
 * or is synced via rsync/scp (out of scope for this adapter).
 */
export class SshAdapter implements Adapter {
  constructor(private options: SshAdapterOptions) {}

  async invoke(skill: LoadedSkill, input: Record<string, unknown>): Promise<AdapterResult> {
    const { host, user, keyPath, timeoutMs = 30000 } = this.options;
    const remoteDir = this.options.remoteSkillDir ?? `/tmp/skills/${path.basename(skill.dirPath)}`;

    const sshArgs = [
      '-o', 'StrictHostKeyChecking=no',
      '-o', 'BatchMode=yes',
    ];
    if (keyPath) {
      sshArgs.push('-i', keyPath);
    }

    const command = `cd ${remoteDir} && OCTOPUS_INPUT='${JSON.stringify(input).replace(/'/g, "'\"'\"'")}' node scripts/invoke.js 2>/dev/null || python3 scripts/invoke.py 2>/dev/null || echo "No invoke script found"`;

    return new Promise((resolve) => {
      const child = spawn('ssh', [...sshArgs, `${user}@${host}`, command], {
        stdio: ['pipe', 'pipe', 'pipe'],
      });

      const killTimer = setTimeout(() => {
        child.kill('SIGTERM');
        resolve({ success: false, error: `SSH sandbox timed out after ${timeoutMs}ms` });
      }, timeoutMs);

      let stdout = '';
      let stderr = '';

      child.stdout.on('data', (d: Buffer) => { stdout += d.toString(); });
      child.stderr.on('data', (d: Buffer) => { stderr += d.toString(); });

      child.on('close', (code: number) => {
        clearTimeout(killTimer);
        if (code !== 0) {
          resolve({ success: false, error: stderr || `SSH exited with code ${code}` });
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
