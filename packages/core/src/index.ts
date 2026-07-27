export { Router, type RoutingResult } from './router.js';
export { Executor, extractCredentialErrors, type ExecutionResult, type CredentialMissingResult, type UnsupportedRuntimeRequirementsResult } from './executor.js';
export { createChatClient, createEmbedClient, skillToText, type ChatClient, type EmbedClient, type LLMConfig } from './llm-client.js';
export { Planner, type ExecutionPlan, type PlanStep, type PlanStepResult, type PlanExecutionResult } from './planner.js';
export { SkillComposer, type CompositionPlan, type CompositionStep, type CompositionResult } from './composer.js';
export { dbg } from './debug.js';
export {
  SandboxRunner,
  SANDBOX_ERROR,
  type SandboxErrorCode,
  type SandboxRunnerDeps,
  type SandboxInvocation,
  type SandboxCommandInput,
  type SandboxRunInput,
  type SandboxSpawnInput,
  type SandboxRunOutput,
  type SandboxSession,
  type BoundSandboxExecutionPort,
} from './sandbox-runner.js';
export { createDefaultSandboxRunner, defaultSnapshotStoreDir } from './sandbox-runner-factory.js';
export { buildSecretProviderFromConfig } from './secret-provider.js';

export {
  loadConfig, getConfig, resetConfig,
  getConfigDir, getConfigPath, getEnvPath,
  saveConfigFile, saveEnvFile,
} from './config-resolver.js';
export type {
  ResolvedConfig, OctopusConfigV2,
  AgentConfigSection, AgentsConfigSection,
  SandboxConfigSection, CanvasConfigSection, CompanionConfigSection,
} from './config-types.js';
