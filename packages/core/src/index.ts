export { Router, type RoutingResult } from './router.js';
export { Executor, extractCredentialErrors, type ExecutionResult, type CredentialMissingResult, type BinaryMissingResult } from './executor.js';
export { createChatClient, createEmbedClient, skillToText, type ChatClient, type EmbedClient, type LLMConfig } from './llm-client.js';
export { Planner, type ExecutionPlan, type PlanStep, type PlanStepResult, type PlanExecutionResult } from './planner.js';
export { dbg } from './debug.js';

export {
  loadConfig, getConfig, resetConfig,
  getConfigDir, getConfigPath, getEnvPath,
  saveConfigFile, saveEnvFile,
} from './config-resolver.js';
export type { ResolvedConfig, OctopusConfigV2 } from './config-types.js';
