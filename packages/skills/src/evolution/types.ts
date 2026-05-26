export type ChangeRisk = 'safe' | 'risky';

export interface EvolutionSignal {
  ts: string;
  type: 'invocation' | 'feedback' | 'evolution' | 'rollback';
  // invocation fields
  success?: boolean;
  latencyMs?: number;
  tokenUsage?: number;
  error?: string | null;
  // feedback fields
  positive?: boolean;
  comment?: string;
  // evolution / rollback fields
  change?: string;
  risk?: ChangeRisk;
  from?: string;
  to?: string;
}

export interface EvolutionChange {
  field: 'description' | 'triggers' | 'requires' | 'instructions';
  risk: ChangeRisk;
  original: string;
  proposed: string;
  rationale: string;
}

export interface EvolutionProposal {
  skillName: string;
  skillDirPath: string;
  generatedAt: string;
  evidence: string;
  changes: EvolutionChange[];
}

export interface EvolutionState {
  enabled: boolean;
  lastAnalysisAt: string | null;
  signalsSinceLastAnalysis: number;
}
