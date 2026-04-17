export type TaskType = 'one-shot' | 'long-running' | 'agent-collab';

export interface RatingDimensions {
  completion: number;   // 0.0–1.0
  quality: number;      // 0.0–5.0
  reliability: number;  // 0.0–1.0
  latency: number;      // 0.0–1.0
  tokenCost: number;    // 0.0–1.0
}

export interface DimensionWeights {
  completion: number;
  quality: number;
  reliability: number;
  latency: number;
  tokenCost: number;
}

const TASK_TYPE_WEIGHTS: Record<TaskType, DimensionWeights> = {
  'one-shot': {
    completion: 0.30,
    quality: 0.25,
    reliability: 0.20,
    latency: 0.15,
    tokenCost: 0.10,
  },
  'long-running': {
    completion: 0.25,
    quality: 0.20,
    reliability: 0.30,
    latency: 0.10,
    tokenCost: 0.15,
  },
  'agent-collab': {
    completion: 0.20,
    quality: 0.30,
    reliability: 0.25,
    latency: 0.10,
    tokenCost: 0.15,
  },
};

export function getWeightsForTaskType(taskType: TaskType): DimensionWeights {
  return TASK_TYPE_WEIGHTS[taskType];
}

export function computeRoutingScore(
  dimensions: RatingDimensions,
  taskType: TaskType = 'one-shot',
): number {
  const w = getWeightsForTaskType(taskType);
  const qualityNorm = dimensions.quality / 5.0;

  const raw =
    w.completion * dimensions.completion +
    w.quality * qualityNorm +
    w.reliability * dimensions.reliability +
    w.latency * dimensions.latency +
    w.tokenCost * dimensions.tokenCost;

  return Math.max(0, Math.min(1, raw));
}

export function defaultDimensions(): RatingDimensions {
  return {
    completion: 1.0,
    quality: 3.0,
    reliability: 1.0,
    latency: 0.5,
    tokenCost: 0.5,
  };
}
