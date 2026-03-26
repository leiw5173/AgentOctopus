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

// Core — router, executor, LLM client
export {
  Router,
  Executor,
  createChatClient,
  createEmbedClient,
  skillToText,
} from '@agentoctopus/core';
export type {
  RoutingResult,
  ExecutionResult,
  ChatClient,
  EmbedClient,
  LLMConfig,
} from '@agentoctopus/core';

// Gateway — IM bots, agent protocol, sessions
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
} from '@agentoctopus/gateway';
export type {
  OctopusEngine,
  Session,
  SessionMessage,
  SlackGatewayOptions,
  DiscordGatewayOptions,
  TelegramGatewayOptions,
} from '@agentoctopus/gateway';
