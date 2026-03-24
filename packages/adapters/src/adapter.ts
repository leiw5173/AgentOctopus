import type { LoadedSkill } from '@octopus/registry';

export interface AdapterResult {
  success: boolean;
  data?: unknown;
  error?: string;
  rawText?: string;
}

export interface Adapter {
  invoke(skill: LoadedSkill, input: Record<string, unknown>): Promise<AdapterResult>;
}
