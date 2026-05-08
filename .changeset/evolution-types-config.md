---
"@agentoctopus/core": patch
"@agentoctopus/skills": patch
---

feat(evolution): add EvolutionConfig schema, types, and config wiring

Introduces the EvolutionConfigSchema (Zod) with defaults for enabled, autoApplySafe, signalThreshold, feedbackThreshold, staleDays, maxHistorySnapshots, and scheduleCron. Wires the schema into OctopusConfigV2Schema and ResolvedConfig. Adds the EvolutionSignal, EvolutionChange, EvolutionProposal, and EvolutionState TypeScript interfaces in packages/skills/src/evolution/types.ts.
