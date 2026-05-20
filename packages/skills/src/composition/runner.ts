import type { CompositionPlan, CompositionStep } from "./schema.js";

export interface ValidationError {
  step: number;
  message: string;
}

/**
 * Validate a composition plan:
 * 1. Detect cycles (not applicable for linear chains, but future-proof)
 * 2. Ensure all inputMapping references exist as prior outputAs or original context keys
 * 3. Ensure no duplicate outputAs keys
 */
export function validateComposition(plan: CompositionPlan, contextKeys: string[] = []): ValidationError[] {
  const errors: ValidationError[] = [];
  const availableKeys = new Set(contextKeys);
  const outputAsKeys = new Set<string>();

  for (let i = 0; i < plan.steps.length; i++) {
    const step = plan.steps[i];

    // Check for duplicate outputAs
    if (step.outputAs) {
      if (outputAsKeys.has(step.outputAs)) {
        errors.push({ step: i, message: `Duplicate outputAs key: "${step.outputAs}"` });
      }
      outputAsKeys.add(step.outputAs);
    }

    // Validate inputMapping references
    if (step.inputMapping) {
      for (const source of Object.values(step.inputMapping)) {
        if (!availableKeys.has(source)) {
          errors.push({ step: i, message: `inputMapping references unavailable key: "${source}"` });
        }
      }
    }

    // Add this step's outputAs to available keys for downstream steps
    if (step.outputAs) {
      availableKeys.add(step.outputAs);
    }
  }

  return errors;
}

/**
 * Detect cycles in a composition plan.
 * For now, compositions are linear chains (no branching/joining),
 * so cycles can only occur if a step references itself.
 */
export function detectCycles(plan: CompositionPlan): ValidationError[] {
  const errors: ValidationError[] = [];

  for (let i = 0; i < plan.steps.length; i++) {
    const step = plan.steps[i];
    if (step.inputMapping) {
      for (const [target, source] of Object.entries(step.inputMapping)) {
        if (source === step.outputAs) {
          errors.push({ step: i, message: `Step references its own outputAs as input: "${source}"` });
        }
      }
    }
  }

  return errors;
}

export function isValidComposition(plan: CompositionPlan, contextKeys?: string[]): boolean {
  const validationErrors = validateComposition(plan, contextKeys);
  const cycleErrors = detectCycles(plan);
  return validationErrors.length === 0 && cycleErrors.length === 0;
}
