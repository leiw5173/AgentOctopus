import type { LoadedSkill } from '@agentoctopus/registry';
import type { ChatClient } from './llm-client.js';
import type { Router, RoutingResult } from './router.js';
import type { Executor, ExecutionResult } from './executor.js';

// --- Plan types ---

export interface PlanStep {
  id: string;
  query: string;             // sub-task query
  dependsOn: string[];       // IDs of steps that must complete first
  skill?: string;            // resolved skill name (null if direct LLM)
  useDirectLLM: boolean;     // true = answer with chat LLM, no skill
}

export interface ExecutionPlan {
  originalQuery: string;
  steps: PlanStep[];
  isMultiHop: boolean;       // true if decomposed into >1 step
}

export interface PlanStepResult {
  stepId: string;
  query: string;
  skill: string | null;
  confidence: number;
  output: string;
  success: boolean;
}

export interface PlanExecutionResult {
  plan: ExecutionPlan;
  stepResults: PlanStepResult[];
  finalAnswer: string;
}

// --- Planner ---

export class Planner {
  constructor(
    private chatClient: ChatClient,
    private router: Router,
    private executor: Executor,
  ) {}

  /**
   * Analyze a query and produce an execution plan.
   * Simple queries → single step. Complex queries → decomposed into sub-tasks.
   */
  async plan(query: string, skills: LoadedSkill[]): Promise<ExecutionPlan> {
    const skillList = skills.map((s) => s.manifest.name).join(', ');

    const systemPrompt = `You are a task planner. Given a user request and a list of available skills, determine if the request needs to be broken into multiple sub-tasks.

Available skills: ${skillList}

Rules:
- If the request is a single, simple task → return exactly one step.
- If the request contains multiple distinct sub-tasks (e.g. "translate X AND check weather in Y") → decompose into separate steps.
- If a later step depends on the output of an earlier step, mark the dependency.
- Each step should have a clear, standalone query.

Respond in this exact JSON format (no other text):
{"steps": [{"id": "1", "query": "the sub-task query", "dependsOn": []}]}

For multi-step with dependency:
{"steps": [{"id": "1", "query": "first task", "dependsOn": []}, {"id": "2", "query": "second task using result of first", "dependsOn": ["1"]}]}`;

    const userMessage = `User request: "${query}"`;

    let steps: PlanStep[];

    try {
      const response = await this.chatClient.chat(systemPrompt, userMessage);
      const parsed = extractJSON(response);

      if (parsed && Array.isArray(parsed.steps) && parsed.steps.length > 0) {
        steps = parsed.steps.map((s: any) => ({
          id: String(s.id),
          query: String(s.query || query),
          dependsOn: Array.isArray(s.dependsOn) ? s.dependsOn.map(String) : [],
          useDirectLLM: false,
        }));
      } else {
        // Fallback: single step with original query
        steps = [{ id: '1', query, dependsOn: [], useDirectLLM: false }];
      }
    } catch {
      // LLM failed — treat as single step
      steps = [{ id: '1', query, dependsOn: [], useDirectLLM: false }];
    }

    return {
      originalQuery: query,
      steps,
      isMultiHop: steps.length > 1,
    };
  }

  /**
   * Execute a plan: route each step to a skill (or direct LLM), respecting dependencies.
   * Steps without dependencies run in parallel.
   */
  async execute(plan: ExecutionPlan): Promise<PlanExecutionResult> {
    const results = new Map<string, PlanStepResult>();
    const pending = new Set(plan.steps.map((s) => s.id));

    while (pending.size > 0) {
      // Find steps whose dependencies are all resolved
      const ready = plan.steps.filter(
        (s) => pending.has(s.id) && s.dependsOn.every((dep) => results.has(dep)),
      );

      if (ready.length === 0) {
        // Circular dependency or broken plan — execute remaining sequentially
        for (const id of pending) {
          const step = plan.steps.find((s) => s.id === id)!;
          const result = await this.executeStep(step, results);
          results.set(step.id, result);
          pending.delete(step.id);
        }
        break;
      }

      // Execute ready steps in parallel
      const stepResults = await Promise.all(
        ready.map((step) => this.executeStep(step, results)),
      );

      for (const result of stepResults) {
        results.set(result.stepId, result);
        pending.delete(result.stepId);
      }
    }

    // Collect ordered results
    const orderedResults = plan.steps.map((s) => results.get(s.id)!);

    // Synthesize final answer
    const finalAnswer = await this.synthesize(plan, orderedResults);

    return { plan, stepResults: orderedResults, finalAnswer };
  }

  /**
   * Plan and execute in one call — convenience method.
   */
  async run(query: string, skills: LoadedSkill[]): Promise<PlanExecutionResult> {
    const plan = await this.plan(query, skills);
    return this.execute(plan);
  }

  // --- Private helpers ---

  private async executeStep(
    step: PlanStep,
    priorResults: Map<string, PlanStepResult>,
  ): Promise<PlanStepResult> {
    // Substitute dependency outputs into the query
    let resolvedQuery = step.query;
    for (const depId of step.dependsOn) {
      const depResult = priorResults.get(depId);
      if (depResult) {
        resolvedQuery += `\n\n[Context from previous step: ${depResult.output}]`;
      }
    }

    // Try routing to a skill
    const routes = await this.router.route(resolvedQuery);

    if (routes.length === 0) {
      // No skill matched — use direct LLM
      try {
        const answer = await this.chatClient.chat(
          'You are a helpful assistant. Answer concisely and accurately.',
          resolvedQuery,
        );
        return {
          stepId: step.id,
          query: step.query,
          skill: null,
          confidence: 0,
          output: answer,
          success: true,
        };
      } catch (err) {
        return {
          stepId: step.id,
          query: step.query,
          skill: null,
          confidence: 0,
          output: `Failed to answer: ${(err as Error).message}`,
          success: false,
        };
      }
    }

    // Execute the matched skill
    const best = routes[0]!;
    try {
      const result = await this.executor.execute(best.skill, {
        query: resolvedQuery,
        text: resolvedQuery,
      });

      return {
        stepId: step.id,
        query: step.query,
        skill: best.skill.manifest.name,
        confidence: best.confidence,
        output: result.formattedOutput,
        success: result.adapterResult.success,
      };
    } catch (err) {
      return {
        stepId: step.id,
        query: step.query,
        skill: best.skill.manifest.name,
        confidence: best.confidence,
        output: `Execution failed: ${(err as Error).message}`,
        success: false,
      };
    }
  }

  private async synthesize(
    plan: ExecutionPlan,
    results: PlanStepResult[],
  ): Promise<string> {
    // Single step — return output directly
    if (results.length === 1) {
      return results[0]!.output;
    }

    // Multi-step — use LLM to combine results into a coherent answer
    const stepSummaries = results
      .map(
        (r, i) =>
          `Step ${i + 1} (${r.skill || 'general knowledge'}): ${r.output}`,
      )
      .join('\n\n');

    try {
      const combined = await this.chatClient.chat(
        'You are a helpful assistant. Combine the following sub-task results into a single, coherent response for the user. Be concise.',
        `Original question: "${plan.originalQuery}"\n\nResults:\n${stepSummaries}`,
      );
      return combined;
    } catch {
      // Fallback: just concatenate
      return results.map((r) => r.output).join('\n\n');
    }
  }
}

/**
 * Extract a JSON object from an LLM response that may contain markdown fences or extra text.
 */
function extractJSON(text: string): any {
  // Try direct parse first
  try {
    return JSON.parse(text.trim());
  } catch {
    // noop
  }

  // Try extracting from markdown code fence
  const fenceMatch = text.match(/```(?:json)?\s*([\s\S]*?)```/);
  if (fenceMatch) {
    try {
      return JSON.parse(fenceMatch[1]!.trim());
    } catch {
      // noop
    }
  }

  // Try finding first { ... }
  const braceMatch = text.match(/\{[\s\S]*\}/);
  if (braceMatch) {
    try {
      return JSON.parse(braceMatch[0]);
    } catch {
      // noop
    }
  }

  return null;
}
