import { z } from "zod";

export const CompositionStepSchema = z.object({
  skill: z.string(),
  inputMapping: z.record(z.string(), z.string()).optional(),
  outputAs: z.string().optional(),
  condition: z.string().optional(),
});

export const CompositionPlanSchema = z.object({
  steps: z.array(CompositionStepSchema).min(1),
});

export type CompositionStep = z.infer<typeof CompositionStepSchema>;
export type CompositionPlan = z.infer<typeof CompositionPlanSchema>;
