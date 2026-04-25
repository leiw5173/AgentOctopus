import * as cp from 'node:child_process';
import path from 'node:path';
import fs from 'node:fs';
import type { LoadedSkill } from '@agentoctopus/registry';
import type { Adapter, AdapterResult } from './adapter.js';

/** Read the SKILL.md body (below the frontmatter) without adding a gray-matter dependency. */
function readSkillBody(dirPath: string): string {
  try {
    const raw = fs.readFileSync(path.join(dirPath, 'SKILL.md'), 'utf-8');
    const match = raw.match(/^---[\s\S]*?---\s*([\s\S]*)$/);
    return (match ? match[1] : raw).trim();
  } catch {
    return '';
  }
}

/**
 * Find the entry script and runtime for a skill.
 *
 * Resolution order:
 * 1. scripts/invoke.js — our convention (Node subprocess)
 * 2. scripts/invoke.py — our convention (Python subprocess)
 * 3. Parse SKILL.md instructions for a script reference (e.g. "python3 scripts/foo.py")
 * 4. First .js file in scripts/ → node
 * 5. First .py file in scripts/ → python3
 */
function findEntryScript(skill: LoadedSkill): { scriptPath: string; runtime: string } | null {
  const scriptsDir = path.join(skill.dirPath, 'scripts');
  if (!fs.existsSync(scriptsDir)) return null;

  // 1. invoke.js (our convention)
  const invokeJs = path.join(scriptsDir, 'invoke.js');
  if (fs.existsSync(invokeJs)) return { scriptPath: invokeJs, runtime: 'node' };

  // 2. invoke.py (our convention)
  const invokePy = path.join(scriptsDir, 'invoke.py');
  if (fs.existsSync(invokePy)) return { scriptPath: invokePy, runtime: 'python3' };

  // 3. Parse SKILL.md instructions for script references
  const instructions = readSkillBody(skill.dirPath);
  const scriptRef = parseScriptReference(instructions, scriptsDir);
  if (scriptRef) return scriptRef;

  // 4-5. Fallback: first .js or .py file
  try {
    const files = fs.readdirSync(scriptsDir);
    const firstJs = files.find(f => f.endsWith('.js'));
    if (firstJs) return { scriptPath: path.join(scriptsDir, firstJs), runtime: 'node' };

    const firstPy = files.find(f => f.endsWith('.py'));
    if (firstPy) return { scriptPath: path.join(scriptsDir, firstPy), runtime: 'python3' };
  } catch {
    // not readable
  }

  return null;
}

/**
 * Parse SKILL.md instructions to find a script reference.
 * Looks for patterns like:
 *   python3 scripts/foo.py
 *   python scripts/foo.py
 *   bash scripts/foo.sh
 *   node scripts/foo.js
 *   scripts/foo.py
 */
function parseScriptReference(instructions: string, scriptsDir: string): { scriptPath: string; runtime: string } | null {
  // Match: (python3|python|node|bash) scripts/foo.ext OR just scripts/foo.ext
  const scriptPattern = /(?:python3?|node|bash)\s+(scripts\/[\w.-]+\.(?:py|js|sh))|scripts\/([\w.-]+\.(?:py|js|sh))/g;
  let match: RegExpExecArray | null;

  while ((match = scriptPattern.exec(instructions)) !== null) {
    const relPath = match[1] || match[2];
    if (!relPath) continue;

    const fullPath = path.join(path.dirname(scriptsDir), relPath);
    if (fs.existsSync(fullPath)) {
      const ext = path.extname(fullPath);
      const runtime = ext === '.py' ? 'python3' : ext === '.js' ? 'node' : 'bash';
      return { scriptPath: fullPath, runtime };
    }
  }

  return null;
}

/** Env vars always passed through to subprocess skills. */
const SANDBOX_PASSTHROUGH_VARS = ['PATH', 'HOME', 'TMPDIR', 'TEMP', 'TMP', 'LANG', 'TZ', 'TERM'];
const SKILL_EXEC_TIMEOUT_MS = parseInt(process.env.SKILL_EXEC_TIMEOUT_MS ?? '30000', 10);

export class SubprocessAdapter implements Adapter {
  async invoke(skill: LoadedSkill, input: Record<string, unknown>): Promise<AdapterResult> {
    const entry = findEntryScript(skill);

    if (!entry) {
      return { success: false, error: `No script found in ${skill.dirPath}/scripts/` };
    }

    const isNode = entry.runtime === 'node';

    return new Promise((resolve) => {
      // Build sandboxed env: only safe vars + skill-declared credentials
      const safeEnv: NodeJS.ProcessEnv = {};
      for (const key of SANDBOX_PASSTHROUGH_VARS) {
        if (process.env[key] !== undefined) safeEnv[key] = process.env[key];
      }
      const credKeys: string[] = [];
      const creds = (skill.manifest.credentials ?? []) as Array<{ key: string }>;
      for (const c of creds) credKeys.push(c.key);
      const ocEnv = (skill.manifest.metadata as any)?.openclaw?.env;
      if (Array.isArray(ocEnv)) {
        for (const k of ocEnv) { if (typeof k === 'string') credKeys.push(k); }
      }
      for (const key of credKeys) {
        if (process.env[key] !== undefined) safeEnv[key] = process.env[key];
      }
      safeEnv['OCTOPUS_INPUT'] = JSON.stringify(input);

      // For Node scripts: use process.execPath to ensure we use the current Node binary
      // and bypass Turbopack's constant folding for spawn/exec asset tracing.
      // For Python scripts: use python3 from PATH.
      const cmd = isNode ? process.execPath : entry.runtime;
      const child = cp.spawn(cmd, [entry.scriptPath], {
        env: safeEnv,
        stdio: ['pipe', 'pipe', 'pipe'],
      });

      const killTimer = setTimeout(() => {
        child.kill('SIGTERM');
        resolve({ success: false, error: `Skill timed out after ${SKILL_EXEC_TIMEOUT_MS}ms` });
      }, SKILL_EXEC_TIMEOUT_MS);

      let stdout = '';
      let stderr = '';

      child.stdout.on('data', (d) => { stdout += d.toString(); });
      child.stderr.on('data', (d) => { stderr += d.toString(); });

      child.on('close', (code) => {
        clearTimeout(killTimer);
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
        clearTimeout(killTimer);
        resolve({ success: false, error: err.message });
      });

      // Send input via stdin as well
      child.stdin.write(JSON.stringify(input));
      child.stdin.end();
    });
  }
}
