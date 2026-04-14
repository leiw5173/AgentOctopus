import type { LoadedSkill, SkillRegistry } from '@agentoctopus/registry';
import type { AdapterResult } from '@agentoctopus/adapters';
import { HttpAdapter, McpAdapter, SubprocessAdapter } from '@agentoctopus/adapters';

export interface ExecutionResult {
  skill: LoadedSkill;
  adapterResult: AdapterResult;
  formattedOutput: string;
}

export class Executor {
  private http = new HttpAdapter();
  private mcp = new McpAdapter();
  private subprocess = new SubprocessAdapter();

  constructor(private registry: SkillRegistry) {}

  async execute(skill: LoadedSkill, input: Record<string, unknown>): Promise<ExecutionResult> {
    // Check required credentials before invoking
    const missing = (skill.manifest.credentials ?? [])
      .filter(c => c.required !== false && !process.env[c.key])
      .map(c => c.key);

    if (missing.length > 0) {
      const lines = missing.map(k => `  ${k}`).join('\n');
      throw new Error(
        `✘ Skill "${skill.manifest.name}" requires environment variables that are not set:\n\n${lines}\n\nRun: octopus config set ${missing[0]} <your-value>`,
      );
    }

    const adapter = this.pickAdapter(skill);
    const adapterResult = await adapter.invoke(skill, input);

    // Record invocation in registry
    this.registry.recordInvocation(skill.manifest.name);

    const formattedOutput = this.format(adapterResult);

    return { skill, adapterResult, formattedOutput };
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
}
