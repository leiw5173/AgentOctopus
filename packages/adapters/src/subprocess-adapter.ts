import * as cp from 'node:child_process';
import path from 'node:path';
import type { LoadedSkill } from '@agentoctopus/registry';
import type { Adapter, AdapterResult } from './adapter.js';

export class SubprocessAdapter implements Adapter {
  async invoke(skill: LoadedSkill, input: Record<string, unknown>): Promise<AdapterResult> {
    const scriptPath = path.join(skill.dirPath, 'scripts', 'invoke.js');

    return new Promise((resolve) => {
      // Use process.execPath to ensure we use the current Node binary,
      // and to bypass Turbopack's constant folding for spawn/exec asset tracing.
      const cmd = process.execPath;
      const child = cp.spawn(cmd, [scriptPath], {
        env: { ...process.env, OCTOPUS_INPUT: JSON.stringify(input) },
        stdio: ['pipe', 'pipe', 'pipe'],
      });

      let stdout = '';
      let stderr = '';

      child.stdout.on('data', (d) => { stdout += d.toString(); });
      child.stderr.on('data', (d) => { stderr += d.toString(); });

      child.on('close', (code) => {
        if (code !== 0) {
          resolve({ success: false, error: stderr || `Process exited with code ${code}` });
        } else {
          try {
            const data = JSON.parse(stdout);
            resolve({ success: true, data, rawText: stdout });
          } catch {
            resolve({ success: true, rawText: stdout });
          }
        }
      });

      child.on('error', (err) => {
        resolve({ success: false, error: err.message });
      });

      // Send input via stdin as well
      child.stdin.write(JSON.stringify(input));
      child.stdin.end();
    });
  }
}
