import type { LoadedSkill, SkillRegistry, RequiredEnvVar } from '@agentoctopus/registry';
import { getRequiredEnvVars, getRequiredBins, getSkillEntry } from '@agentoctopus/registry';
import type { AdapterResult, AdapterInvocationContext } from '@agentoctopus/adapters';
import { HttpAdapter, McpAdapter, SubprocessAdapter } from '@agentoctopus/adapters';
import type { ChatClient } from './llm-client.js';
import { isBinAvailable } from './utils.js';
import { dbg } from './debug.js';
import { getConfig } from './config-resolver.js';
import { recordExecutionSignal } from './evolution-hook.js';
import { SkillComposer } from './composer.js';
import type { Router } from './router.js';
import { SandboxRunner } from './sandbox-runner.js';
import { createDefaultSandboxRunner } from './sandbox-runner-factory.js';
import type { ExecutionContext, TelemetrySink, AdapterCompletedEvent } from './execution-context.js';
import { runOutputValidator, type OutputValidator } from './output-validator.js';
import { randomUUID } from 'node:crypto';
import fs from 'fs';
import path from 'path';

/** Bounded budget for the injected output validator — a hung validator must
 *  never stall execute(). */
const OUTPUT_VALIDATOR_TIMEOUT_MS = 5000;

const SKILL_EXECUTION_SYSTEM_PROMPT = `You are a skill execution agent. Given a skill's instructions and a user query, determine the exact command to run.

Rules:
- Read the skill instructions carefully to understand available commands and their arguments
- Pick the command that best matches the user's intent
- Output ONLY the command to run, nothing else — no explanation, no markdown
- ALWAYS use relative paths (e.g. "python3 scripts/baseball.py games", NOT absolute paths)
- If the instructions show absolute paths, convert them to relative paths from the skill directory
- If the skill has scripts/, use the script path relative to the skill directory
- If the instructions say to use python3, node, or bash, include that in the command
- If the skill uses CLI tools (e.g. npx), compose the command directly — skip setup/prerequisite steps and go to the action command
- If the action command requires an ID or key from a prior step, run the list/check command first to discover it
- The command will be executed from the skill's directory`;

const HTTP_EXECUTION_SYSTEM_PROMPT = `You are a skill execution agent for HTTP API skills. Given a skill's API instructions and a user query, determine the exact curl command to run.

Rules:
- Read the skill instructions carefully to understand the API endpoints, methods, and parameters
- Pick the endpoint and method that best matches the user's intent
- Match the endpoint type to what the user is looking for: content/news/posts → timeline/feed/content endpoints; users/accounts → user search endpoints. Never use a user/account search endpoint when the user wants content.
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

export interface UnsupportedRuntimeRequirementsResult {
  type: 'unsupported_runtime_requirements';
  skillName: string;
  missing: string[];
  message: string;
}

export interface ExecutorOptions {
  execContext?: ExecutionContext;
  telemetrySink?: TelemetrySink;
  outputValidator?: OutputValidator;
}

export class Executor {
  private http = new HttpAdapter();
  private mcp = new McpAdapter();
  private subprocess = new SubprocessAdapter();
  private composer?: SkillComposer;
  private readonly sandboxRunner: SandboxRunner;
  private readonly execContext?: ExecutionContext;
  private readonly telemetrySink?: TelemetrySink;
  private readonly outputValidator?: OutputValidator;

  constructor(
    private registry: SkillRegistry,
    private chatClient?: ChatClient,
    private router?: Router,
    sandboxRunner?: SandboxRunner,
    options?: ExecutorOptions,
  ) {
    // The SandboxRunner is the SOLE execution boundary for every non-MCP skill
    // path. Inject one in tests; production call sites get the default built
    // from the trusted octopus.json sandbox config. There is NO host fallback.
    this.sandboxRunner = sandboxRunner ?? createDefaultSandboxRunner();
    if (this.router && this.chatClient) {
      this.composer = new SkillComposer(this.registry, this.router, this, this.chatClient);
    }
    this.execContext = options?.execContext;
    this.telemetrySink = options?.telemetrySink;
    this.outputValidator = options?.outputValidator;
  }

  /**
   * Build the invocation context every adapter call receives: a sandbox port
   * already bound to this skill, plus the payload and timeout.
   */
  private invocationContext(skill: LoadedSkill, payload: unknown): AdapterInvocationContext {
    return {
      sandbox: this.sandboxRunner.bind(skill),
      payload,
      timeoutMs: getConfig().execution.timeoutMs,
    };
  }

  /**
   * Read-only effective credential env for the pre-flight GUARD. Merges
   * process.env with octopus.json `skills.entries[<skill>]` apiKey/env
   * overrides WITHOUT mutating process.env (the runner owns execution env).
   */
  private effectiveCredentialEnv(skill: LoadedSkill): Record<string, string | undefined> {
    const view: Record<string, string | undefined> = { ...process.env };
    try {
      const entry = getSkillEntry(skill);
      const skillKey = entry.metadata.skillKey ?? entry.skill.name;
      const config = getConfig().skills.entries?.[skillKey];
      if (entry.metadata.primaryEnv && config?.apiKey && !(entry.metadata.primaryEnv in view)) {
        view[entry.metadata.primaryEnv] = config.apiKey;
      }
      if (config?.env) {
        for (const [k, v] of Object.entries(config.env)) {
          if (!(k in view) && v !== undefined) view[k] = v;
        }
      }
    } catch {
      // config overrides are advisory for the guard; ignore resolution errors
    }
    return view;
  }

  async execute(skill: LoadedSkill, input: Record<string, unknown>, opts: { debug?: boolean } = {}): Promise<ExecutionResult | CredentialMissingResult | UnsupportedRuntimeRequirementsResult> {
    const { debug = false } = opts;

    let adapterResult: AdapterResult | undefined;
    let latencyMs: number = 0;
    let tokenUsage: number = 0;

    try {
    // Check required credentials before invoking. This is a GUARD, not
    // execution — the runner owns env hygiene and credential provisioning, so
    // we do NOT mutate process.env here. Config-supplied keys (octopus.json
    // skills.entries) are read via a read-only effective-env view.
    const effectiveEnv = this.effectiveCredentialEnv(skill);
    const required = getRequiredEnvVars(skill.manifest);
    const missing = required.filter(v => !effectiveEnv[v.key]);

    if (missing.length > 0) {
      return {
        type: 'credential_missing',
        skillName: skill.manifest.name,
        missing,
      } satisfies CredentialMissingResult;
    }

    // Check required binaries before invoking. SKILL.md may DECLARE
    // requires.bins, but must NEVER trigger host package-manager execution.
    // Trusted sandbox.runtimeProfiles (octopus.json) maps approved bins to
    // digest-pinned images; when no single trusted profile covers the missing
    // bins we return a typed UNSUPPORTED result with no host side effects.
    const requiredBins = getRequiredBins(skill.manifest);
    const missingBins = requiredBins.filter(bin => !isBinAvailable(bin));
    if (missingBins.length > 0) {
      return {
        type: 'unsupported_runtime_requirements',
        skillName: skill.manifest.name,
        missing: missingBins,
        message: `no single trusted runtime profile covers requested bins: ${missingBins.join(', ')}`,
      } satisfies UnsupportedRuntimeRequirementsResult;
    }

    // Handle composed skills (skill chaining)
    if (skill.manifest.adapter === 'composed') {
      if (!this.composer) {
        return {
          skill,
          adapterResult: { success: false, error: 'SkillComposer not available — router required for composed skills' },
          formattedOutput: 'Error: SkillComposer not available — router required for composed skills',
        };
      }
      const composeResult = await this.composer.executeChain(skill, input);
      return {
        skill,
        adapterResult: { success: composeResult.success, rawText: composeResult.finalOutput, error: composeResult.error },
        formattedOutput: composeResult.success ? composeResult.finalOutput : `Error: ${composeResult.error}`,
      };
    }

    // Lazily load SKILL.md body from disk — needed for adapter inference and execution
    const instructions = this.registry.readInstructions(skill);

    let adapter = this.pickAdapter(skill);

    // Infer subprocess adapter for skills that have scripts or CLI commands but no endpoint declared.
    // Many community skills omit the adapter field (defaulting to http) but ship
    // scripts/ that should be invoked as subprocess, not LLM-guided curl.
    if (skill.manifest.adapter === 'http' && !skill.manifest.endpoint && skill.dirPath) {
      const scriptsDir = path.join(skill.dirPath, 'scripts');
      let useSubprocess = false;
      try {
        useSubprocess = fs.existsSync(scriptsDir) && fs.readdirSync(scriptsDir).length > 0;
      } catch {
        // scripts/ not readable
      }

      // Detect CLI-based skills (npx commands) that should use subprocess LLM-guided execution
      if (!useSubprocess && /\bnpx\s+/.test(instructions)) {
        useSubprocess = true;
      }

      if (useSubprocess) {
        adapter = this.subprocess;
      }
    }

    const effectiveAdapterName = adapter === this.subprocess ? 'subprocess' : adapter === this.mcp ? 'mcp' : 'http';
    dbg(debug, `Adapter: ${effectiveAdapterName}${effectiveAdapterName !== skill.manifest.adapter ? ` (manifest: ${skill.manifest.adapter})` : ''}`);
    dbg(debug, `Input payload: ${JSON.stringify(input).slice(0, 200)}`);
    const startTime = Date.now();
    try {
      // For subprocess skills, check if we should use LLM-guided execution
      if (adapter === this.subprocess && this.chatClient) {
        adapterResult = await this.executeSubprocessWithLLM(skill, input, adapter, instructions);
      } else if (skill.manifest.adapter === 'http' && !skill.manifest.endpoint && this.chatClient) {
        // HTTP skill with no endpoint — use LLM-guided curl execution
        adapterResult = await this.executeHttpWithLLM(skill, input, instructions);
      } else {
        adapterResult = await adapter.invoke({ skill, input }, this.invocationContext(skill, input));
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

    // Post-execution: optional caller-injected output validation. Runs ONLY
    // when the adapter succeeded — a failed output has no payload to validate.
    // When no validator is injected, surface the explicit 'no validator'
    // sentinel so downstream telemetry consumers can distinguish it from a
    // real validator failure.
    let outputValidated = false;
    let outputValidationReason: string | null = null;
    if (!adapterResult.success) {
      outputValidationReason = 'adapter failed';
    } else if (!this.outputValidator) {
      outputValidationReason = 'no validator';
    } else {
      const vr = await runOutputValidator(this.outputValidator, adapterResult, OUTPUT_VALIDATOR_TIMEOUT_MS);
      outputValidated = vr.ok;
      outputValidationReason = vr.reason;
    }

    // T3.4: emit adapter.completed AFTER the detectHttpErrorInOutput mutation
    // so adapterSuccess reflects the FINAL success flag, and after the output
    // validator so the event carries its verdict. Fire-and-forget: a throwing
    // sink must never break execute(). NEVER carry rawText/output content.
    this.emitAdapterCompleted(adapterResult, outputValidated, outputValidationReason);

    // Post-execution: detect auth errors and append setup guidance
    const authGuidance = await this.diagnoseAuthError(adapterResult, skill, instructions);

    return { skill, adapterResult, formattedOutput, authGuidance: authGuidance ?? undefined };
    } finally {
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
    adapter: { invoke: (input: { skill: LoadedSkill; input: Record<string, unknown> }, context: AdapterInvocationContext) => Promise<AdapterResult> },
    instructions: string,
  ): Promise<AdapterResult> {
    // If skill has invoke.js, use standard subprocess execution
    const fs = await import('fs');
    const path = await import('path');
    const invokeJs = path.join(skill.dirPath, 'scripts', 'invoke.js');
    if (fs.existsSync(invokeJs)) {
      return adapter.invoke({ skill, input }, this.invocationContext(skill, input));
    }

    // LLM-guided: ask the LLM what command to run based on SKILL.md instructions
    if (!this.chatClient) {
      return adapter.invoke({ skill, input }, this.invocationContext(skill, input));
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

    // Credential hygiene: the prompt may carry credential KEY NAMES plus a
    // value-free configured/not-configured boolean — NEVER a value, NEVER an
    // `= <anything>` interpolation. Values reach ONLY the trusted egress proxy
    // via SandboxRunner.provisionSecrets. Presence is read from the same
    // effective view the guard uses (process.env + octopus.json overrides).
    const subRequiredEnvVars = getRequiredEnvVars(skill.manifest);
    const subEffectiveEnv = this.effectiveCredentialEnv(skill);
    const subCredHints = subRequiredEnvVars.length > 0
      ? `\n\nCredentials (key names only — values are injected by the runtime, never shown here):\n${subRequiredEnvVars
          .map(v => `  ${v.key} (${subEffectiveEnv[v.key] ? 'configured' : 'not configured'})`)
          .join('\n')}`
      : '';

    const userMessage = `Skill: ${skill.manifest.name}\nDescription: ${skill.manifest.description}\n\nInstructions:\n${rewrittenInstructions}\n\nUser query: "${query}"${subCredHints}\n\nWhat command should I run?`;

    const command = await this.chatClient.chat(SKILL_EXECUTION_SYSTEM_PROMPT, userMessage);
    let trimmedCommand = command.trim();

    if (!trimmedCommand) {
      // Fallback to standard subprocess execution
      return adapter.invoke({ skill, input }, this.invocationContext(skill, input));
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

    // Execute the LLM-determined command INSIDE the sandbox. The runner
    // rewrites relative script paths to /skill/..., sets cwd=/skill, and
    // applies guest env hygiene (payload → OCTOPUS_INPUT). No host spawn.
    const result = await this.sandboxRunner.bind(skill).run({
      command: ['bash', '-c', trimmedCommand],
      invocation: { payload: input },
      timeoutMs: getConfig().execution.timeoutMs,
    });

    if (!result.success) {
      return {
        success: false,
        error: result.error ?? result.stderr ?? `Command failed in sandbox: ${trimmedCommand}`,
        rawText: result.rawText,
      };
    }
    return { success: true, rawText: result.rawText ?? '' };
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

    // Credential hygiene: same rule as the subprocess path — KEY NAMES plus a
    // configured/not-configured boolean only, NEVER a value, no broad env scan.
    // The egress proxy injects the actual credential at request time.
    const requiredEnvVars = getRequiredEnvVars(skill.manifest);
    const httpEffectiveEnv = this.effectiveCredentialEnv(skill);
    const credHints = requiredEnvVars.length > 0
      ? `\n\nCredentials (key names only — values are injected by the runtime, never shown here):\n${requiredEnvVars
          .map(v => `  ${v.key} (${httpEffectiveEnv[v.key] ? 'configured' : 'not configured'})`)
          .join('\n')}\nReference the credential by its env var name (e.g. $${requiredEnvVars[0]!.key}) in the command — do NOT hardcode any value.`
      : '';

    const userMessage = `Skill: ${skill.manifest.name}\nDescription: ${skill.manifest.description}\n\nAPI Instructions:\n${rewrittenInstructions}\n\nUser query: "${query}"${credHints}\n\nWhat curl command should I run?`;

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

    // Execute the LLM-determined curl command INSIDE the sandbox. Egress goes
    // only through the per-session egress proxy, which enforces host/method/path
    // and injects credentials — no host fetch/spawn, no process.env keys passed.
    const result = await this.sandboxRunner.bind(skill).run({
      command: ['bash', '-c', trimmedCommand],
      invocation: { payload: input },
      timeoutMs: getConfig().execution.timeoutMs,
    });

    if (!result.success) {
      return {
        success: false,
        error: result.error ?? result.stderr ?? `Command failed in sandbox: ${trimmedCommand}`,
        rawText: result.rawText,
      };
    }
    return { success: true, rawText: result.rawText ?? '' };
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
      case 'composed':
        // Composed skills are handled at a higher level before pickAdapter
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

    // Read credential PRESENCE from the same effective view the pre-flight
    // guard uses (process.env + octopus.json overrides) — never the VALUE.
    const effectiveEnv = this.effectiveCredentialEnv(skill);

    // 1. Check manifest credentials (env vars)
    const required = getRequiredEnvVars(skill.manifest);
    if (required.length > 0) {
      for (const v of required) {
        const label = v.label ? ` — ${v.label}` : '';
        const isSet = !!effectiveEnv[v.key];
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
          const isSet = !!effectiveEnv[v];
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
        'access denied', 'invalid api key', 'invalid token', 'authentication', 'authorization'];
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

  /**
   * T3.4 — emit `adapter.completed` through the optional injected sink.
   * Fire-and-forget: a throwing sink is caught and ignored. NEVER carries
   * rawText/output content — only structured metadata. Per the binding brief
   * note, the Executor NEVER emits `request.completed`/`request.failed`; the
   * gateway /ask handler owns the terminal event.
   */
  private emitAdapterCompleted(
    adapterResult: AdapterResult,
    outputValidated: boolean,
    outputValidationReason: string | null,
  ): void {
    if (!this.telemetrySink) return;
    try {
      const event: AdapterCompletedEvent = {
        kind: 'adapter.completed',
        traceId: this.execContext?.traceId,
        executionId: this.execContext?.executionId ?? randomUUID(),
        adapterSuccess: adapterResult.success,
        errorCode: this.normalizeErrorCode(adapterResult.error),
        outputValidated,
        outputValidationReason,
      };
      this.telemetrySink.emit(event);
    } catch {
      // telemetry must never break execute()
    }
  }

  /**
   * Normalize an adapter error string to a stable machine-readable code.
   * Maps common cases; falls back to the first whitespace-separated token;
   * returns null when there is no error.
   */
  private normalizeErrorCode(error: string | undefined): string | null {
    if (!error) return null;
    if (/EAI_AGAIN/.test(error)) return 'EAI_AGAIN';
    if (/ECONNREFUSED/.test(error)) return 'ECONNREFUSED';
    if (/host not granted/i.test(error)) return 'host not granted';
    const httpMatch = error.match(/\b(4\d\d|5\d\d)\b/);
    if (httpMatch) return httpMatch[1]!;
    const firstToken = error.trim().split(/\s+/)[0];
    return firstToken && firstToken.length > 0 ? firstToken : null;
  }
}
