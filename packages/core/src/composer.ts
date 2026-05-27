import type { LoadedSkill, SkillRegistry } from '@agentoctopus/registry';
import type { Router, RoutingResult } from './router.js';
import type { Executor } from './executor.js';
import type { ChatClient } from './llm-client.js';

export interface CompositionStep {
  skill: string;
  inputMapping?: Record<string, string>;
  outputAs?: string;
  condition?: string;
}

export interface CompositionPlan {
  steps: CompositionStep[];
}

export interface CompositionStepResult {
  stepIndex: number;
  skillName: string;
  output: string;
  success: boolean;
  structuredOutput?: Record<string, unknown>;
}

export interface CompositionResult {
  success: boolean;
  stepResults: CompositionStepResult[];
  finalOutput: string;
  error?: string;
}

/**
 * SkillComposer executes composed skill chains.
 * Parses a CompositionPlan DAG, routes each step to its skill,
 * substitutes outputs into downstream step inputs.
 */
export class SkillComposer {
  constructor(
    private registry: SkillRegistry,
    private router: Router,
    private executor: Executor,
    private chatClient: ChatClient,
  ) {}

  async executeChain(skill: LoadedSkill, input: Record<string, unknown>): Promise<CompositionResult> {
    const compose = skill.manifest.compose;
    if (!compose || !compose.steps || compose.steps.length === 0) {
      return { success: false, stepResults: [], finalOutput: '', error: 'No composition steps defined' };
    }

    const stepResults: CompositionStepResult[] = [];
    const context: Record<string, unknown> = { ...input };

    for (let i = 0; i < compose.steps.length; i++) {
      const step = compose.steps[i];
      const stepSkill = this.registry.getByName(step.skill);
      if (!stepSkill) {
        stepResults.push({ stepIndex: i, skillName: step.skill, output: '', success: false });
        return { success: false, stepResults, finalOutput: '', error: `Step ${i}: skill "${step.skill}" not found` };
      }

      // Build step query from inputMapping + context
      let stepQuery = this.buildStepQuery(step, context);

      // Evaluate condition if present
      if (step.condition) {
        const shouldRun = await this.evaluateCondition(step.condition, context);
        if (!shouldRun) {
          stepResults.push({ stepIndex: i, skillName: step.skill, output: '(skipped by condition)', success: true });
          continue;
        }
      }

      // Route and execute
      const routes = await this.router.route(stepQuery);
      if (routes.length === 0 || routes[0].skill.manifest.name !== stepSkill.manifest.name) {
        // Fallback: execute directly without routing match
        const result = await this.executor.execute(stepSkill, { query: stepQuery });
        if ('type' in result) {
          stepResults.push({ stepIndex: i, skillName: step.skill, output: String(result), success: false });
          return { success: false, stepResults, finalOutput: '', error: `Step ${i}: execution failed` };
        }
        const output = result.formattedOutput;
        stepResults.push({ stepIndex: i, skillName: step.skill, output, success: result.adapterResult.success });
        if (step.outputAs) {
          context[step.outputAs] = output;
        }
        continue;
      }

      const best = routes[0];
      const result = await this.executor.execute(best.skill, { query: stepQuery });

      if ('type' in result) {
        stepResults.push({ stepIndex: i, skillName: step.skill, output: String(result), success: false });
        return { success: false, stepResults, finalOutput: '', error: `Step ${i}: execution failed` };
      }

      const output = result.formattedOutput;
      stepResults.push({
        stepIndex: i,
        skillName: step.skill,
        output,
        success: result.adapterResult.success,
        structuredOutput: this.tryParseStructured(output),
      });

      if (step.outputAs) {
        context[step.outputAs] = output;
      }
    }

    // Synthesize final output
    const finalOutput = await this.synthesize(stepResults, context);
    return { success: true, stepResults, finalOutput };
  }

  private buildStepQuery(step: CompositionStep, context: Record<string, unknown>): string {
    if (!step.inputMapping || Object.keys(step.inputMapping).length === 0) {
      return String(context.query ?? context.text ?? '');
    }

    const parts: string[] = [];
    for (const [target, source] of Object.entries(step.inputMapping)) {
      const value = context[source];
      if (value !== undefined) {
        parts.push(`${target}: ${value}`);
      }
    }
    return parts.join('\n');
  }

  private async evaluateCondition(condition: string, context: Record<string, unknown>): Promise<boolean> {
    try {
      const prompt = `Evaluate this condition given the context. Output ONLY "true" or "false" (no other text).

Condition: ${condition}
Context: ${JSON.stringify(context, null, 2)}`;
      const response = await this.chatClient.chat('You are a condition evaluator. Reply with exactly "true" or "false".', prompt);
      return response.trim().toLowerCase() === 'true';
    } catch {
      return true; // default to running on error
    }
  }

  private tryParseStructured(text: string): Record<string, unknown> | undefined {
    try {
      const parsed = JSON.parse(text.trim());
      if (typeof parsed === 'object' && parsed !== null) {
        return parsed as Record<string, unknown>;
      }
    } catch {
      // not JSON
    }
    return undefined;
  }

  private async synthesize(stepResults: CompositionStepResult[], context: Record<string, unknown>): Promise<string> {
    const originalQuery = String(context.query ?? context.text ?? '');
    if (stepResults.length === 1) {
      return stepResults[0].output;
    }

    const summaries = stepResults
      .map((r, i) => `Step ${i + 1} (${r.skillName}): ${r.output.slice(0, 300)}`)
      .join('\n\n');

    try {
      const combined = await this.chatClient.chat(
        'You are a helpful assistant. Combine the following step results into a single coherent response.',
        `Original request: "${originalQuery}"\n\n${summaries}`,
      );
      return combined.trim();
    } catch {
      return stepResults.map((r) => r.output).join('\n\n');
    }
  }
}
