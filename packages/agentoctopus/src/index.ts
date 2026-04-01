// Registry — skill loading, manifests, ratings
export {
  SkillRegistry,
  SkillManifestSchema,
  RatingStore,
  fetchRemoteCatalog,
} from '@agentoctopus/registry';
export type {
  SkillManifest,
  Adapter,
  Auth,
  LoadedSkill,
  RatingEntry,
  RatingsStore,
  CatalogEntry,
  LoadedCatalogSkill,
} from '@agentoctopus/registry';

// Adapters — HTTP, MCP, subprocess execution
export {
  HttpAdapter,
  McpAdapter,
  SubprocessAdapter,
} from '@agentoctopus/adapters';
export type {
  AdapterResult,
} from '@agentoctopus/adapters';

// Core — router, executor, LLM client, planner
export {
  Router,
  Executor,
  Planner,
  createChatClient,
  createEmbedClient,
  skillToText,
} from '@agentoctopus/core';
export type {
  RoutingResult,
  ExecutionResult,
  ExecutionPlan,
  PlanStep,
  PlanStepResult,
  PlanExecutionResult,
  ChatClient,
  EmbedClient,
  LLMConfig,
} from '@agentoctopus/core';

// Gateway — IM bots, agent protocol, sessions, security
export {
  bootstrapEngine,
  resetEngine,
  sessionManager,
  SessionManager,
  startSlackGateway,
  startDiscordGateway,
  startTelegramGateway,
  createAgentRouter,
  startAgentGateway,
  // Security middleware
  authMiddleware,
  loadApiKeys,
  createApiKey,
  revokeApiKey,
  upgradeApiKey,
  validateApiKey,
  flushApiKeys,
  generateApiKey,
  TIER_LIMITS,
  rateLimiter,
  resetRateLimiter,
  auditLogger,
  closeAuditLog,
  resetAuditLogger,
} from '@agentoctopus/gateway';
export type {
  OctopusEngine,
  Session,
  SessionMessage,
  SlackGatewayOptions,
  DiscordGatewayOptions,
  TelegramGatewayOptions,
  ApiKeyEntry,
  ApiKeyTier,
  ApiKeysStore,
  AuditEntry,
} from '@agentoctopus/gateway';

// Onboarding
export { runOnboarding, ensureOnboarded } from '@agentoctopus/cli/dist/onboard.js';
