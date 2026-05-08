import type { LoadedSkill, SkillRegistry, RequiredEnvVar } from '@agentoctopus/registry';
import { getRequiredEnvVars, getRequiredBins } from '@agentoctopus/registry';
import type { AdapterResult } from '@agentoctopus/adapters';
import { HttpAdapter, McpAdapter, SubprocessAdapter } from '@agentoctopus/adapters';
import { applySkillEnvOverrides } from '@agentoctopus/skills';
import type { ChatClient } from './llm-client.js';
import { isBinAvailable } from './utils.js';
import { dbg } from './debug.js';
import { getConfig } from './config-resolver.js';
import { recordExecutionSignal } from './evolution-hook.js';
import fs from 'fs';
import path from 'path';

const SANDBOX_PASSTHROUGH_VARS = ['PATH', 'HOME', 'TMPDIR', 'TEMP', 'TMP', 'LANG', 'TZ', 'TERM'];

function buildSandboxedEnv(skill: LoadedSkill): NodeJS.ProcessEnv {
  const safe: NodeJS.ProcessEnv = {};
  for (const key of SANDBOX_PASSTHROUGH_VARS) {
    if (process.env[key] !== undefined) safe[key] = process.env[key];
  }
  for (const v of getRequiredEnvVars(skill.manifest)) {
    if (process.env[v.key] !== undefined) safe[v.key] = process.env[v.key];
  }
  return safe;
}

/**
 * Build a lightweight adapter from LoadedSkill to a shape compatible with
 * applySkillEnvOverrides from @agentoctopus/skills.
 */
function loadedSkillToEnvEntry(skill: LoadedSkill) {
  const rawMeta = (skill.manifest.metadata ?? {}) as Record<string, unknown>;
  const openclaw = (rawMeta.openclaw ?? {}) as Record<string, unknown>;
  return {
    skill: { name: skill.manifest.name },
    metadata: {
      skillKey: (openclaw.skillKey as string) ?? undefined,
      primaryEnv: (rawMeta.primaryEnv as string) ?? (openclaw.primaryEnv as string) ?? undefined,
      always: (rawMeta.always as boolean) ?? undefined,
      os: (rawMeta.os as string[]) ?? undefined,
      requires: (rawMeta.requires as any) ?? undefined,
    },
  };
}

const SKILL_EXECUTION_SYSTEM_PROMPT = `You are a skill execution agent. Given a skill's instructions and a user query, determine the exact command to run.

Rules:
- Read the skill instructions carefully to understand available commands and their arguments
- Pick the command that best matches the user's intent
- Output ONLY the command to run, nothing else — no explanation, no markdown
- ALWAYS use relative paths (e.g. "python3 scripts/baseball.py games", NOT absolute paths)
- If the instructions show absolute paths, convert them to relative paths from the skill directory
- If the skill has scripts/, use the script path relative to the skill directory
- If the instructions say to use python3, node, or bash, include that in the command
- The command will be executed from the skill's directory`;

const HTTP_EXECUTION_SYSTEM_PROMPT = `You are a skill execution agent for HTTP API skills. Given a skill's API instructions and a user query, determine the exact curl command to run.

Rules:
- Read the skill instructions carefully to understand the API endpoints, methods, and parameters
- Pick the endpoint and method that best matches the user's intent
- Output ONLY the curl command to run, nothing else — no explanation, no markdown
- ONLY produce curl commands — NEVER produce python3, node, bash, or any local script commands
- If the instructions reference local scripts (e.g. python3 scripts/foo.py), ignore those — find the underlying HTTP API endpoint instead
- Include the correct HTTP method (-X POST, -X DELETE, etc.)
- Include -H "Content-Type: application/json" for JSON bodies
- Include -H "Authorization: Bearer $API_KEY" if the API requires auth (use env var syntax)
- Put the JSON body in -d '{...}' if needed
- If you cannot determine a valid curl command from the instructions, output exactly "NONE"
- The command will be executed via bash`;

const AUTH_DIAGNOSIS_PROMPT = `You are a helpful assistant diagnosing an API authentication error. Given a skill's instructions and the error, provide a concise setup guide.

Rules:
- Read the skill instructions to find how to get an API key or access token
- Include the signup/registration URL if mentioned
- Include the exact steps to configure the key
- If the skill uses MCP, mention the MCP setup command
- Keep it under 5 lines
- Format as plain text, no markdown`;

export function extractCredentialErrors(text: string): string[] {
  const scan = text.slice(0, 2000);
  const keyPattern = /[A-Z][A-Z0-9_]*(?:API_KEY|_KEY|_TOKEN|_SECRET|_URL)/g;

  const triggers = [
    /([A-Z][A-Z0-9_]*(?:API_KEY|_KEY|_TOKEN|_SECRET|_URL))\s+(?:environment\s+variable\s+)?is\s+not\s+set/gi,
    /(?:requires?|needs?|missing)\s+([A-Z][A-Z0-9_]*(?:API_KEY|_KEY|_TOKEN|_SECRET|_URL))/gi,
  ];

  const found = new Set<string>();

  for (const re of triggers) {
    let m: RegExpExecArray | null;
    while ((m = re.exec(scan)) !== null) {
      found.add(m[1]!);
    }
  }

  // Handle comma-separated lists: "requires KEY1, KEY2, KEY3, or KEY4"
  if (found.size > 0) {
    const sentencePattern = /(?:requires?|needs?|missing)\s+[^.;\n]{0,300}/gi;
    let sm: RegExpExecArray | null;
    while ((sm = sentencePattern.exec(scan)) !== null) {
      const sentence = sm[0];
      let km: RegExpExecArray | null;
      while ((km = keyPattern.exec(sentence)) !== null) {
        found.add(km[0]);
      }
    }
  }

  return [...found];
}

export interface ExecutionResult {
  skill: LoadedSkill;
  adapterResult: AdapterResult;
  formattedOutput: string;
  authGuidance?: string;
}

export interface CredentialMissingResult {
  type: 'credential_missing';
  skillName: string;
  missing: RequiredEnvVar[];
}

export interface BinaryMissingResult {
  type: 'binary_missing';
  skillName: string;
  missing: string[];
}

export class Executor {
  private http = new HttpAdapter();
  private mcp = new McpAdapter();
  private subprocess = new SubprocessAdapter();

  constructor(private registry: SkillRegistry, private chatClient?: ChatClient) {}

  async execute(skill: LoadedSkill, input: Record<string, unknown>, opts: { debug?: boolean } = {}): Promise<ExecutionResult | CredentialMissingResult | BinaryMissingResult> {
    const { debug = false } = opts;

    // Apply env overrides from skills config before credential check.
    // Overrides set configured apiKey/env vars into process.env so that
    // skills with credentials in octopus.json can pass the check below.
    const skillsConfig = getConfig().skills;
    const revertEnv = applySkillEnvOverrides(
      [loadedSkillToEnvEntry(skill) as any],
      skillsConfig as any,
    );

    let adapterResult: AdapterResult | undefined;
    let latencyMs: number = 0;
    let tokenUsage: number = 0;

    try {
    // Check required credentials before invoking
    const required = getRequiredEnvVars(skill.manifest);
    const missing = required.filter(v => !process.env[v.key]);

    if (missing.length > 0) {
      return {
        type: 'credential_missing',
        skillName: skill.manifest.name,
        missing,
      } satisfies CredentialMissingResult;
    }

    // Check required binaries before invoking
    const requiredBins = getRequiredBins(skill.manifest);
    const missingBins = requiredBins.filter(bin => !isBinAvailable(bin));
    if (missingBins.length > 0) {
      return { type: 'binary_missing', skillName: skill.manifest.name, missing: missingBins };
    }

    let adapter = this.pickAdapter(skill);

    // Infer subprocess adapter for skills that have scripts but no endpoint declared.
    // Many community skills omit the adapter field (defaulting to http) but ship
    // scripts/ that should be invoked as subprocess, not LLM-guided curl.
    if (skill.manifest.adapter === 'http' && !skill.manifest.endpoint && skill.dirPath) {
      const scriptsDir = path.join(skill.dirPath, 'scripts');
      try {
        const hasScripts = fs.existsSync(scriptsDir) && fs.readdirSync(scriptsDir).length > 0;
        if (hasScripts) {
          adapter = this.subprocess;
        }
      } catch {
        // scripts/ not readable — stay with http adapter
      }
    }

    const effectiveAdapterName = adapter === this.subprocess ? 'subprocess' : adapter === this.mcp ? 'mcp' : 'http';
    dbg(debug, `Adapter: ${effectiveAdapterName}${effectiveAdapterName !== skill.manifest.adapter ? ` (manifest: ${skill.manifest.adapter})` : ''}`);
    dbg(debug, `Input payload: ${JSON.stringify(input).slice(0, 200)}`);
    const startTime = Date.now();
    // Lazily load SKILL.md body from disk — only for the selected skill, not at startup
    const instructions = this.registry.readInstructions(skill);
    try {
      // For subprocess skills, check if we should use LLM-guided execution
      if (adapter === this.subprocess && this.chatClient) {
        adapterResult = await this.executeSubprocessWithLLM(skill, input, adapter, instructions);
      } else if (skill.manifest.adapter === 'http' && !skill.manifest.endpoint && this.chatClient) {
        // HTTP skill with no endpoint — use LLM-guided curl execution
        adapterResult = await this.executeHttpWithLLM(skill, input, instructions);
      } else {
        adapterResult = await adapter.invoke(skill, input);
      }
    } catch (err) {
      latencyMs = Date.now() - startTime;
      this.registry.recordInvocationMetrics(skill.manifest.name, {
        success: false,
        latencyMs,
        tokenUsage: 0,
      });
      throw err;
    }
    latencyMs = Date.now() - startTime;

    if (adapterResult.rawText) {
      dbg(debug, `Raw output (first 200 chars): "${adapterResult.rawText.slice(0, 200).trim()}"`);
    }
    if (!adapterResult.success && adapterResult.error) {
      dbg(debug, `Adapter error: ${adapterResult.error.slice(0, 200)}`);
    }
    dbg(debug, `Execution time: ${latencyMs}ms`);

    // Record invocation metrics in registry
    tokenUsage = typeof (adapterResult as any).tokenUsage === 'number' ? (adapterResult as any).tokenUsage : 0;
    this.registry.recordInvocationMetrics(skill.manifest.name, {
      success: adapterResult.success,
      latencyMs,
      tokenUsage,
    });

    const formattedOutput = this.format(adapterResult);

    // Post-execution: detect HTTP errors in "successful" subprocess output
    // (curl returns exit 0 even on 429/401/403 — mark as failed so retry can try next skill)
    if (adapterResult.success && adapterResult.rawText) {
      const httpError = this.detectHttpErrorInOutput(adapterResult.rawText);
      if (httpError) {
        adapterResult = { success: false, error: httpError, rawText: adapterResult.rawText };
      }
    }

    // Post-execution: detect auth errors and append setup guidance
    const authGuidance = await this.diagnoseAuthError(adapterResult, skill, instructions);

    return { skill, adapterResult, formattedOutput, authGuidance: authGuidance ?? undefined };
    } finally {
      revertEnv();
      try {
        if (skill.dirPath && latencyMs > 0) {
          recordExecutionSignal(
            skill.dirPath,
            adapterResult !== undefined ? adapterResult.success : false,
            latencyMs,
            tokenUsage,
            adapterResult !== undefined ? (adapterResult.error ?? null) : null,
          );
        }
      } catch {
        // evolution signal recording must never affect execution
      }
    }
  }

  async generateCredentialGuide(
    skillName: string,
    skillDescription: string,
    missingKeys: string[],
  ): Promise<string> {
    const keyList = missingKeys.join(', ');
    const fallback = missingKeys
      .map(k => `${k} is required but not configured.\n  Run: octopus config set ${k} <your-key>`)
      .join('\n\n');

    if (!this.chatClient) return fallback;

    const prompt = `The CLI tool "octopus" tried to run the skill "${skillName}" (${skillDescription}) but it failed because the following API key(s) are not configured: ${keyList}.

For each missing key, provide a SHORT setup guide with:
1. What provider/service the key is for (one line)
2. The sign-up or API key page URL
3. The command: octopus config set KEY_NAME <your-key>

Keep it concise — 3 lines per key max. No markdown headers.
If you're not confident about the URL, say "Visit the provider's website" instead.`;

    try {
      const guide = await Promise.race([
        this.chatClient.chat('You are a helpful assistant that provides concise API key setup instructions.', prompt),
        new Promise<never>((_, reject) => setTimeout(() => reject(new Error('timeout')), 10_000)),
      ]);
      return guide.trim() || fallback;
    } catch {
      return fallback;
    }
  }

  /**
   * LLM-guided subprocess execution:
   * 1. If the skill has invoke.js, use the standard subprocess adapter
   * 2. Otherwise, ask the LLM to read the SKILL.md instructions and determine
   *    the right command to run, then execute it
   */
  private async executeSubprocessWithLLM(
    skill: LoadedSkill,
    input: Record<string, unknown>,
    adapter: { invoke: (skill: LoadedSkill, input: Record<string, unknown>) => Promise<AdapterResult> },
    instructions: string,
  ): Promise<AdapterResult> {
    // If skill has invoke.js, use standard subprocess execution
    const fs = await import('fs');
    const path = await import('path');
    const invokeJs = path.join(skill.dirPath, 'scripts', 'invoke.js');
    if (fs.existsSync(invokeJs)) {
      return adapter.invoke(skill, input);
    }

    // LLM-guided: ask the LLM what command to run based on SKILL.md instructions
    if (!this.chatClient) {
      return adapter.invoke(skill, input);
    }

    const query = (input.query ?? input.text ?? '') as string;

    // Rewrite OpenClaw workspace paths in instructions to the actual skill directory.
    // Community skills reference ~/.openclaw/workspace/skills/<name>/ but may be
    // installed elsewhere (e.g. ~/.agentoctopus/skills/<name>/).
    const instrHomeDir = process.env.HOME || process.env.USERPROFILE || '';
    const instrPathPattern = /~\/\.openclaw\/workspace\/skills\/[^/\s]+/g;
    const rewrittenInstructions = instructions.replace(instrPathPattern, (match) => {
      const expanded = match.replace(/^~/, instrHomeDir);
      if (fs.existsSync(expanded)) return match; // path exists, leave it
      return skill.dirPath; // redirect to actual install location
    });

    // Build credential context for the LLM so it can include auth in commands
    const subRequiredEnvVars = getRequiredEnvVars(skill.manifest);
    const subCredLines: string[] = [];
    if (subRequiredEnvVars.length > 0) {
      for (const v of subRequiredEnvVars) {
        const val = process.env[v.key];
        if (val) {
          subCredLines.push(`  ${v.key} = ${val} (already set)`);
        } else {
          subCredLines.push(`  ${v.key} = NOT SET${v.label ? ` (${v.label})` : ''}`);
        }
      }
    }
    const subCredContext = subCredLines.length > 0
      ? `\n\nAvailable credentials:\n${subCredLines.join('\n')}`
      : '';

    const userMessage = `Skill: ${skill.manifest.name}\nDescription: ${skill.manifest.description}\n\nInstructions:\n${rewrittenInstructions}\n\nUser query: "${query}"${subCredContext}\n\nWhat command should I run?`;

    const command = await this.chatClient.chat(SKILL_EXECUTION_SYSTEM_PROMPT, userMessage);
    let trimmedCommand = command.trim();

    if (!trimmedCommand) {
      // Fallback to standard subprocess execution
      return adapter.invoke(skill, input);
    }

    // Safety net: rewrite any absolute path to the skill's scripts/ directory.
    // Community skills often have absolute paths from the author's machine in SKILL.md.
    // Match patterns like /any/path/to/skill-name/scripts/foo.ext
    const absoluteScriptMatch = trimmedCommand.match(/^(.*?)(\/[^\s]*\/scripts\/[\w.-]+\.(?:py|js|sh))(.*)$/);
    if (absoluteScriptMatch) {
      const [, prefix, , suffix] = absoluteScriptMatch;
      const scriptName = absoluteScriptMatch[2].split('/scripts/')[1];
      trimmedCommand = `${prefix}scripts/${scriptName}${suffix}`;
    }

    // Validate that any referenced scripts exist on disk
    const scriptError = this.validateCommandScripts(trimmedCommand, skill.dirPath);
    if (scriptError) {
      return { success: false, error: scriptError };
    }

    // Rewrite OpenClaw workspace paths to the actual skill directory.
    // Skills installed from ClaWHub reference ~/.openclaw/workspace/skills/<name>/
    // but may be installed at a different location (e.g. ~/.agentoctopus/skills/<name>/).
    const openclawPathPattern = /~\/\.openclaw\/workspace\/skills\/[^/\s]+/g;
    const homeDir = process.env.HOME || process.env.USERPROFILE || '';
    trimmedCommand = trimmedCommand.replace(openclawPathPattern, (match) => {
      // Only rewrite if the referenced path doesn't actually exist
      const expanded = match.replace(/^~/, homeDir);
      if (fs.existsSync(expanded)) return match; // path exists, leave it
      return skill.dirPath; // redirect to actual install location
    });

    // Execute the LLM-determined command from the skill's directory
    const cp = await import('node:child_process');
    return new Promise((resolve) => {
      const sandboxEnv = buildSandboxedEnv(skill);
      sandboxEnv['OCTOPUS_INPUT'] = JSON.stringify(input);
      const child = cp.spawn('bash', ['-c', trimmedCommand], {
        cwd: skill.dirPath,
        env: sandboxEnv,
        stdio: ['pipe', 'pipe', 'pipe'],
      });

      const killTimer = setTimeout(() => {
        child.kill('SIGTERM');
        resolve({ success: false, error: `Skill timed out after ${getConfig().execution.timeoutMs}ms: ${trimmedCommand}` });
      }, getConfig().execution.timeoutMs);

      let stdout = '';
      let stderr = '';

      child.stdout.on('data', (d: Buffer) => { stdout += d.toString(); });
      child.stderr.on('data', (d: Buffer) => { stderr += d.toString(); });

      child.on('close', (code: number) => {
        clearTimeout(killTimer);
        if (code !== 0) {
          resolve({ success: false, error: stderr || `Command exited with code ${code}: ${trimmedCommand}` });
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

  /**
   * LLM-guided HTTP execution:
   * Ask the LLM to read the SKILL.md API instructions and determine
   * the right curl command to run, then execute it.
   */
  private async executeHttpWithLLM(
    skill: LoadedSkill,
    input: Record<string, unknown>,
    instructions: string,
  ): Promise<AdapterResult> {
    if (!this.chatClient) {
      return { success: false, error: `Skill "${skill.manifest.name}" has no endpoint and no LLM available for guided execution` };
    }

    // Pre-flight: if the SKILL.md describes only local scripts (no https:// URLs),
    // the LLM-guided curl path will always fail. Return immediately with a helpful error.
    const hasHttpUrl = /https?:\/\//.test(instructions);
    const hasLocalScripts = /scripts\/[\w.-]+\.(?:py|js|sh|ts)/.test(instructions);

    // Also check for actual script files on disk — some skills have scripts/
    // but don't reference them explicitly in SKILL.md.
    let hasScriptFiles = false;
    try {
      const scriptsDir = path.join(skill.dirPath, 'scripts');
      hasScriptFiles = fs.existsSync(scriptsDir)
        && fs.readdirSync(scriptsDir).some(f => /\.(?:py|js|sh|ts)$/.test(f));
    } catch {
      // not readable
    }

    if ((hasLocalScripts || hasScriptFiles) && !hasHttpUrl) {
      const skillName = skill.manifest.name;
      return {
        success: false,
        error: `Skill "${skillName}" uses local scripts that aren\'t installed on this machine. Install it with:\n  octopus add ${skillName} --force`,
      };
    }

    // Second pre-flight: if the skill has no scripts and no endpoint, verify the
    // instructions actually describe an HTTP API before trying LLM-guided curl.
    // Skills that only reference agent tools (web_fetch, web_search, etc.) and
    // have documentation URLs (github.com) are not HTTP API skills.
    if (!hasLocalScripts && !hasScriptFiles && !skill.manifest.endpoint) {
      const apiUrlPattern = /https?:\/\/[^\s/]*api[^\s/]*|curl\s+-X|https?:\/\/[^\s/?]+\/[^\s]*\?[^\s]+=[^\s]+/i;
      const isDocUrl = (url: string) => /github\.com|gitlab\.com|bitbucket\.org|raw\.githubusercontent\.com/i.test(url);
      const urls = instructions.match(/https?:\/\/[^\s]+/g) ?? [];
      const apiUrls = urls.filter(u => !isDocUrl(u) && apiUrlPattern.test(u));
      if (apiUrls.length === 0 && !apiUrlPattern.test(instructions)) {
        const skillName = skill.manifest.name;
        return {
          success: false,
          error: `Skill "${skillName}" does not expose an HTTP API. Its instructions describe agent-level tools rather than API endpoints.`,
        };
      }
    }

    const query = (input.query ?? input.text ?? '') as string;

    // Rewrite OpenClaw workspace paths in instructions (same as subprocess path)
    const homeDir = process.env.HOME || process.env.USERPROFILE || '';
    const openclawPathPattern = /~\/\.openclaw\/workspace\/skills\/[^/\s]+/g;
    const rewrittenInstructions = instructions.replace(openclawPathPattern, (match) => {
      const expanded = match.replace(/^~/, homeDir);
      if (fs.existsSync(expanded)) return match;
      return skill.dirPath;
    });

    // Build credential context for the LLM so it can include auth headers/tokens
    const requiredEnvVars = getRequiredEnvVars(skill.manifest);
    const credLines: string[] = [];
    if (requiredEnvVars.length > 0) {
      for (const v of requiredEnvVars) {
        const val = process.env[v.key];
        if (val) {
          credLines.push(`  ${v.key} = ${val} (already set)`);
        } else {
          credLines.push(`  ${v.key} = NOT SET${v.label ? ` (${v.label})` : ''}`);
        }
      }
    }
    // Also scan for common API key env vars that are set in the environment
    const commonKeyPattern = /^[A-Z][A-Z0-9_]*_(API_KEY|KEY|TOKEN|SECRET|APIKEY)$/;
    for (const [key, val] of Object.entries(process.env)) {
      if (val && commonKeyPattern.test(key) && !requiredEnvVars.some(v => v.key === key)) {
        credLines.push(`  ${key} = ${val} (available in env)`);
      }
    }
    const credContext = credLines.length > 0
      ? `\n\nAvailable credentials:\n${credLines.join('\n')}\nUse these credentials in the API call (e.g. as Authorization: Bearer <token> header, or as query parameter).`
      : '';

    const userMessage = `Skill: ${skill.manifest.name}\nDescription: ${skill.manifest.description}\n\nAPI Instructions:\n${rewrittenInstructions}\n\nUser query: "${query}"${credContext}\n\nWhat curl command should I run?`;

    const command = await this.chatClient.chat(HTTP_EXECUTION_SYSTEM_PROMPT, userMessage);
    const trimmedCommand = command.trim();

    if (!trimmedCommand) {
      return { success: false, error: `LLM could not determine the API call for skill "${skill.manifest.name}"` };
    }

    // If the LLM returned "NONE", it couldn't find a valid curl command
    if (trimmedCommand.toUpperCase() === 'NONE') {
      return { success: false, error: `Skill "${skill.manifest.name}" does not expose an HTTP API that can be called directly. Its instructions describe local scripts that are not installed.` };
    }

    // Validate that any referenced scripts exist on disk
    const scriptError = this.validateCommandScripts(trimmedCommand, skill.dirPath);
    if (scriptError) {
      return { success: false, error: scriptError };
    }

    // Execute the LLM-determined curl command
    const cp = await import('node:child_process');
    return new Promise((resolve) => {
      const sandboxEnv = buildSandboxedEnv(skill);
      sandboxEnv['OCTOPUS_INPUT'] = JSON.stringify(input);
      const child = cp.spawn('bash', ['-c', trimmedCommand], {
        env: sandboxEnv,
        stdio: ['pipe', 'pipe', 'pipe'],
      });

      const killTimer = setTimeout(() => {
        child.kill('SIGTERM');
        resolve({ success: false, error: `Skill timed out after ${getConfig().execution.timeoutMs}ms: ${trimmedCommand}` });
      }, getConfig().execution.timeoutMs);

      let stdout = '';
      let stderr = '';

      child.stdout.on('data', (d: Buffer) => { stdout += d.toString(); });
      child.stderr.on('data', (d: Buffer) => { stderr += d.toString(); });

      child.on('close', (code: number) => {
        clearTimeout(killTimer);
        if (code !== 0) {
          resolve({ success: false, error: stderr || `Command exited with code ${code}: ${trimmedCommand}` });
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

  /**
   * Validate that script paths referenced in a command exist on disk.
   * Returns an error message if scripts are missing, null if all OK.
   */
  private validateCommandScripts(command: string, skillDir: string): string | null {
    const scriptPattern = /scripts\/([\w.-]+\.(?:py|js|sh))/g;
    const missing: string[] = [];
    let match: RegExpExecArray | null;

    while ((match = scriptPattern.exec(command)) !== null) {
      const relPath = match[0]; // e.g. "scripts/init_collection_run.py"
      const absPath = path.join(skillDir, relPath);
      if (!fs.existsSync(absPath)) {
        missing.push(relPath);
      }
    }

    if (missing.length === 0) return null;

    const skillName = path.basename(skillDir);
    return (
      `Skill "${skillName}" references scripts that are not installed locally:\n` +
      missing.map(s => `  - ${s}`).join('\n') + '\n\n' +
      `This skill was synced without its scripts. To install them, run:\n` +
      `  octopus add ${skillName} --force`
    );
  }

  private pickAdapter(skill: LoadedSkill) {
    switch (skill.manifest.adapter) {
      case 'mcp':
        return this.mcp;
      case 'subprocess':
        return this.subprocess;
      case 'http':
      default:
        return this.http;
    }
  }

  private format(result: AdapterResult): string {
    if (!result.success) {
      return `Error: ${result.error}`;
    }
    if (result.rawText) {
      const text = result.rawText.trim();
      try {
        const parsed = JSON.parse(text);
        // Try common response shapes
        if (typeof parsed === 'string') return parsed;
        if (parsed.result) return String(parsed.result);
        if (parsed.text) return String(parsed.text);
        if (parsed.output) return String(parsed.output);
        if (parsed.translation) return String(parsed.translation);
        return JSON.stringify(parsed, null, 2);
      } catch {
        return text;
      }
    }
    return String(result.data ?? '(no output)');
  }

  /**
   * Detect auth errors in successful responses and provide setup guidance.
   * Uses the LLM to extract setup instructions from SKILL.md when available.
   */
  private async diagnoseAuthError(result: AdapterResult, skill: LoadedSkill, instructions: string): Promise<string | null> {
    // Check results with rawText for auth error patterns.
    // Some skills return HTTP 200 with an error body like {"error": "Missing API key"}
    // so we check both success and failure results.
    if (!result.rawText && !result.error) return null;

    // Try parsing as JSON; fall back to checking the error string
    let parsed: Record<string, unknown> | null = null;
    if (result.rawText) {
      try {
        parsed = JSON.parse(result.rawText.trim());
      } catch {
        // Not JSON — check error string instead
      }
    }

    // Check the error string from failed results
    if (!parsed && result.error) {
      const errLower = result.error.toLowerCase();
      if (errLower.includes('api key') || errLower.includes('apikey') ||
          errLower.includes('unauthorized') || errLower.includes('auth') ||
          errLower.includes('forbidden') || errLower.includes('missing key')) {
        parsed = { error: result.error };
      }
    }

    if (!parsed) return null;

    if (!this.isAuthError(parsed)) return null;

    const lines: string[] = [];
    lines.push(`⚠ Skill "${skill.manifest.name}" requires authentication.`);

    // 1. Check manifest credentials (env vars)
    const required = getRequiredEnvVars(skill.manifest);
    if (required.length > 0) {
      for (const v of required) {
        const label = v.label ? ` — ${v.label}` : '';
        const isSet = !!process.env[v.key];
        if (isSet) {
          lines.push(`  ✓ ${v.key} is set${label}`);
        } else {
          lines.push(`  Set ${v.key}${label}:`);
          lines.push(`    octopus config set ${v.key} <your-key>`);
        }
      }
    } else {
      // No declared credentials — scan instructions for likely env var names
      const envVarPattern = /\b([A-Z][A-Z0-9_]{2,}(?:_API_KEY|_KEY|_TOKEN|_SECRET|_APIKEY))\b/g;
      const foundVars = new Set<string>();
      let m: RegExpExecArray | null;
      while ((m = envVarPattern.exec(instructions)) !== null) {
        foundVars.add(m[1]!);
      }
      if (foundVars.size > 0) {
        for (const v of foundVars) {
          const isSet = !!process.env[v];
          if (isSet) {
            lines.push(`  ✓ ${v} is set`);
          } else {
            lines.push(`  Set ${v}:`);
            lines.push(`    octopus config set ${v} <your-key>`);
          }
        }
      }
    }

    // 2. Check openclaw homepage
    const homepage = skill.manifest.metadata?.openclaw?.homepage;
    if (homepage) {
      lines.push(`  Get your key at: ${homepage}`);
    }

    // 3. Check MCP URL in metadata
    const mcpUrl = (skill.manifest.metadata as Record<string, unknown>)?.mcp_url as string | undefined;
    if (mcpUrl) {
      lines.push(`  MCP endpoint: ${mcpUrl}`);
      lines.push(`    npx mcp-remote ${mcpUrl}`);
    }

    // 4. Use LLM to extract setup guidance from SKILL.md instructions
    if (this.chatClient) {
      try {
        const llmGuidance = await this.chatClient.chat(
          AUTH_DIAGNOSIS_PROMPT,
          `Skill: ${skill.manifest.name}\nDescription: ${skill.manifest.description}\n\nInstructions:\n${instructions}\n\nError: ${JSON.stringify(parsed)}\n\nHow should the user set up authentication for this skill?`,
        );
        if (llmGuidance?.trim()) {
          lines.push('');
          lines.push(llmGuidance.trim());
        }
      } catch {
        // LLM diagnosis failed — the static guidance above is still shown
      }
    }

    return lines.join('\n');
  }

  /**
   * Detect HTTP error responses in subprocess stdout.
   * curl returns exit 0 even on 4xx/5xx, so we need to check the output.
   * Returns an error message if found, or null if the output looks OK.
   */
  private detectHttpErrorInOutput(rawText: string): string | null {
    try {
      const parsed = JSON.parse(rawText.trim());
      const status = parsed.status ?? parsed.statusCode ?? parsed.code ?? parsed.cod;
      const message = parsed.message ?? parsed.error ?? parsed.reason;

      // HTTP 4xx/5xx status codes in response body
      if (typeof status === 'number' && status >= 400) {
        return `HTTP ${status}: ${message ?? rawText.trim().slice(0, 200)}`;
      }

      // status: "error" with a report containing an HTTP error code
      if (status === 'error' || parsed.status === 'error') {
        const report = String(parsed.report ?? parsed.result ?? '');
        const httpInReport = report.match(/\b(4\d{2}|5\d{2})\b/);
        if (httpInReport) {
          return `HTTP ${httpInReport[0]}: ${report.slice(0, 200)}`;
        }
      }

      // Scan all string values for embedded HTTP error patterns
      const allText = rawText.toLowerCase();
      const embeddedHttp = allText.match(/(?:api error|http error|error)\s*\(\s*(4\d{2}|5\d{2})\s*\)/);
      if (embeddedHttp) {
        return `HTTP ${embeddedHttp[1]}: ${rawText.trim().slice(0, 200)}`;
      }

      // Common error patterns without explicit status
      // Flatten nested error objects (e.g. {error: {message: "...", type: "..."}})
      const errorObj = parsed.error;
      const errorStr = (typeof errorObj === 'object' && errorObj !== null
        ? String((errorObj as Record<string, unknown>).message ?? (errorObj as Record<string, unknown>).type ?? JSON.stringify(errorObj))
        : String(errorObj ?? '')).toLowerCase();
      const msg = String(parsed.message ?? '').toLowerCase();
      const authPatterns = ['unauthorized', 'forbidden', 'rate limit', 'too many requests',
        'access denied', 'invalid api key', 'invalid token', 'authentication'];
      if (authPatterns.some(p => errorStr.includes(p) || msg.includes(p))) {
        return `API error: ${message ?? errorStr}`;
      }
    } catch {
      // Not JSON — check for HTTP status in raw text (e.g. curl -i output)
      const httpStatusMatch = rawText.match(/HTTP\/[\d.]+\s+(\d{3})\s+(.+)/);
      if (httpStatusMatch) {
        const code = parseInt(httpStatusMatch[1]!, 10);
        if (code >= 400) {
          return `HTTP ${code}: ${httpStatusMatch[2]!.trim()}`;
        }
      }
    }
    return null;
  }

  /**
   * Detect common auth error patterns in API responses.
   */
  private isAuthError(parsed: Record<string, unknown>): boolean {
    const error = String(parsed.error ?? '').toLowerCase();
    const desc = String(parsed.error_description ?? parsed.message ?? '').toLowerCase();
    const status = parsed.status ?? parsed.statusCode;

    // Common auth error strings
    const authKeywords = ['invalid_token', 'unauthorized', 'access_denied', 'forbidden', 'auth'];
    if (authKeywords.some(k => error.includes(k) || desc.includes(k))) return true;

    // Missing token/key patterns
    if ((error.includes('missing') || desc.includes('missing')) &&
        (error.includes('token') || desc.includes('token') || error.includes('key') || desc.includes('key') || error.includes('api_key') || desc.includes('api_key'))) {
      return true;
    }

    // HTTP status codes
    if (status === 401 || status === 403 || status === 429) return true;

    // 429 / rate limit patterns in message
    if (error.includes('rate limit') || desc.includes('rate limit') ||
        error.includes('too many requests') || desc.includes('too many requests')) return true;

    return false;
  }
}
