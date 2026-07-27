import path from 'node:path';
import fs from 'node:fs';
import type { LoadedSkill } from '@agentoctopus/registry';
import { getSkillEntry } from '@agentoctopus/registry';
import type { Adapter, AdapterInput, AdapterInvocationContext, AdapterResult } from './adapter.js';

/**
 * Find the entry script and runtime for a skill.
 *
 * This is TRUSTED METADATA reading on the host (the skill dir is the source of
 * truth for the snapshot the sandbox mounts at `/skill`). Only the SPAWN moves
 * into the sandbox — discovery stays here.
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
  const instructions = getSkillEntry(skill).skill.instructions;
  const scriptRef = parseScriptReference(instructions, scriptsDir);
  if (scriptRef) return scriptRef;

  // 4-5. Fallback: first .js or .py file
  try {
    const files = fs.readdirSync(scriptsDir);
    const firstJs = files.find(f => f.endsWith('.js'));
    if (firstJs) return { scriptPath: path.join(scriptsDir, firstJs), runtime: 'node' };

    const firstPy = files.find(f => f.endsWith('.py'));
    if (firstPy) return { scriptPath: path.join(scriptsDir, firstPy), runtime: 'python3' };

    const firstSh = files.find(f => f.endsWith('.sh'));
    if (firstSh) return { scriptPath: path.join(scriptsDir, firstSh), runtime: 'bash' };
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

/**
 * Map a host-resolved entry script path to its guest path inside the sandbox.
 * The snapshot (built from skill.dirPath) is mounted at `/skill`, so a host
 * path `<dirPath>/scripts/foo.js` becomes `/skill/scripts/foo.js`. The sandbox
 * runner also rewrites relative/under-skill paths, but we hand it a canonical
 * guest path so the command is unambiguous.
 */
function toGuestScriptPath(skill: LoadedSkill, hostScriptPath: string): string {
  const rel = path.relative(path.resolve(skill.dirPath), path.resolve(hostScriptPath));
  const relPosix = rel.split(path.sep).join('/');
  return `/skill/${relPosix}`;
}

/**
 * Subprocess skill execution. ALL execution happens inside the sandbox via the
 * injected, skill-bound `context.sandbox` port — this adapter has NO host
 * process-spawn access for skill execution. The guest command is
 * `[runtime, /skill/scripts/<entry>]` with the payload serialized to
 * OCTOPUS_INPUT by the runner and piped to stdin.
 */
export class SubprocessAdapter implements Adapter {
  async invoke(input: AdapterInput, context: AdapterInvocationContext): Promise<AdapterResult> {
    const { skill } = input;
    const entry = findEntryScript(skill);

    if (!entry) {
      return { success: false, error: `No script found in ${skill.dirPath}/scripts/` };
    }

    // Ensure script is executable (ClawHub downloads may not preserve +x).
    // Trusted metadata op on the live dir; the snapshot carries the mode bit.
    try { fs.chmodSync(entry.scriptPath, 0o755); } catch { /* non-fatal */ }

    const guestScript = toGuestScriptPath(skill, entry.scriptPath);
    const payload = context.payload ?? input.input;
    const stdin = JSON.stringify(payload);

    const result = await context.sandbox.run({
      command: [entry.runtime, guestScript],
      invocation: { payload, stdin },
      timeoutMs: context.timeoutMs,
    });

    if (!result.success) {
      return {
        success: false,
        error: result.error ?? result.stderr ?? 'Skill execution failed in sandbox',
        rawText: result.rawText,
      };
    }

    const stdout = result.rawText ?? '';
    try {
      const data = JSON.parse(stdout);
      return { success: true, data, rawText: stdout };
    } catch {
      return { success: true, rawText: stdout };
    }
  }
}
