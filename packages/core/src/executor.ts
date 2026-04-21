import type { LoadedSkill, SkillRegistry } from '@agentoctopus/registry';
import { getRequiredEnvVars } from '@agentoctopus/registry';
import type { AdapterResult } from '@agentoctopus/adapters';
import { HttpAdapter, McpAdapter, SubprocessAdapter } from '@agentoctopus/adapters';
import type { ChatClient } from './llm-client.js';
import fs from 'fs';
import path from 'path';

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

export interface ExecutionResult {
  skill: LoadedSkill;
  adapterResult: AdapterResult;
  formattedOutput: string;
}

export class Executor {
  private http = new HttpAdapter();
  private mcp = new McpAdapter();
  private subprocess = new SubprocessAdapter();

  constructor(private registry: SkillRegistry, private chatClient?: ChatClient) {}

  async execute(skill: LoadedSkill, input: Record<string, unknown>): Promise<ExecutionResult> {
    // Check required credentials before invoking
    const required = getRequiredEnvVars(skill.manifest);
    const missing = required.filter(v => !process.env[v.key]);

    if (missing.length > 0) {
      const lines = missing.map(v => {
        if (v.label) return `  - ${v.key} — ${v.label}`;
        return `  - ${v.key}`;
      }).join('\n');
      const homepage = skill.manifest.metadata?.openclaw?.homepage;
      const hint = homepage ? `\n  Get your key at: ${homepage}` : '';
      throw new Error(
        `Skill "${skill.manifest.name}" requires API keys that are not configured:\n\n${lines}${hint}\n\n  To set a key, run:\n    octopus config set ${missing[0].key} <your-key>`,
      );
    }

    const adapter = this.pickAdapter(skill);
    const startTime = Date.now();
    let adapterResult: AdapterResult;
    try {
      // For subprocess skills, check if we should use LLM-guided execution
      if (skill.manifest.adapter === 'subprocess' && this.chatClient) {
        adapterResult = await this.executeSubprocessWithLLM(skill, input, adapter);
      } else if (skill.manifest.adapter === 'http' && !skill.manifest.endpoint && this.chatClient) {
        // HTTP skill with no endpoint — use LLM-guided curl execution
        adapterResult = await this.executeHttpWithLLM(skill, input);
      } else {
        adapterResult = await adapter.invoke(skill, input);
      }
    } catch (err) {
      const latencyMs = Date.now() - startTime;
      this.registry.recordInvocationMetrics(skill.manifest.name, {
        success: false,
        latencyMs,
        tokenUsage: 0,
      });
      throw err;
    }
    const latencyMs = Date.now() - startTime;

    // Record invocation metrics in registry
    const tokenUsage = typeof (adapterResult as any).tokenUsage === 'number' ? (adapterResult as any).tokenUsage : 0;
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
    const authGuidance = await this.diagnoseAuthError(adapterResult, skill);

    return { skill, adapterResult, formattedOutput: authGuidance ? `${formattedOutput}\n\n${authGuidance}` : formattedOutput };
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
    const rewrittenInstructions = skill.instructions.replace(instrPathPattern, (match) => {
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
      const child = cp.spawn('bash', ['-c', trimmedCommand], {
        cwd: skill.dirPath,
        env: { ...process.env, OCTOPUS_INPUT: JSON.stringify(input) },
        stdio: ['pipe', 'pipe', 'pipe'],
      });

      let stdout = '';
      let stderr = '';

      child.stdout.on('data', (d: Buffer) => { stdout += d.toString(); });
      child.stderr.on('data', (d: Buffer) => { stderr += d.toString(); });

      child.on('close', (code: number) => {
        if (code !== 0) {
          resolve({ success: false, error: stderr || `Command exited with code ${code}: ${trimmedCommand}` });
        } else {
          resolve({ success: true, rawText: stdout });
        }
      });

      child.on('error', (err: Error) => {
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
  ): Promise<AdapterResult> {
    if (!this.chatClient) {
      return { success: false, error: `Skill "${skill.manifest.name}" has no endpoint and no LLM available for guided execution` };
    }

    const query = (input.query ?? input.text ?? '') as string;

    // Rewrite OpenClaw workspace paths in instructions (same as subprocess path)
    const fs = await import('fs');
    const homeDir = process.env.HOME || process.env.USERPROFILE || '';
    const openclawPathPattern = /~\/\.openclaw\/workspace\/skills\/[^/\s]+/g;
    const rewrittenInstructions = skill.instructions.replace(openclawPathPattern, (match) => {
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
      const child = cp.spawn('bash', ['-c', trimmedCommand], {
        env: { ...process.env, OCTOPUS_INPUT: JSON.stringify(input) },
        stdio: ['pipe', 'pipe', 'pipe'],
      });

      let stdout = '';
      let stderr = '';

      child.stdout.on('data', (d: Buffer) => { stdout += d.toString(); });
      child.stderr.on('data', (d: Buffer) => { stderr += d.toString(); });

      child.on('close', (code: number) => {
        if (code !== 0) {
          resolve({ success: false, error: stderr || `Command exited with code ${code}: ${trimmedCommand}` });
        } else {
          resolve({ success: true, rawText: stdout });
        }
      });

      child.on('error', (err: Error) => {
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
  private async diagnoseAuthError(result: AdapterResult, skill: LoadedSkill): Promise<string | null> {
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
      const instructions = skill.instructions;
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
          `Skill: ${skill.manifest.name}\nDescription: ${skill.manifest.description}\n\nInstructions:\n${skill.instructions}\n\nError: ${JSON.stringify(parsed)}\n\nHow should the user set up authentication for this skill?`,
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
      const status = parsed.status ?? parsed.statusCode ?? parsed.code;
      const message = parsed.message ?? parsed.error ?? parsed.reason;

      // HTTP 4xx/5xx status codes in response body
      if (typeof status === 'number' && status >= 400) {
        return `HTTP ${status}: ${message ?? rawText.trim().slice(0, 200)}`;
      }

      // Common error patterns without explicit status
      const error = String(parsed.error ?? '').toLowerCase();
      if (error.includes('unauthorized') || error.includes('forbidden') ||
          error.includes('rate limit') || error.includes('too many requests') ||
          error.includes('access denied') || error.includes('invalid api key')) {
        return `API error: ${message ?? error}`;
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
