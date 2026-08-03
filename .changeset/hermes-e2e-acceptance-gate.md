---
'@agentoctopus/cli': minor
'@agentoctopus/core': minor
'@agentoctopus/gateway': minor
'@agentoctopus/sandbox': minor
---

feat: hermes E2E acceptance gate — debug telemetry, per-skill output validators, and executionId correlation

- `@agentoctopus/core`: ExecutionContext telemetry (traceId/executionId propagation through Router→Executor→SandboxRunner); per-skill outputValidators map on Executor (skill-name-keyed lookup, backward-compatible with single outputValidator); debugEndpoints config section; fix executionId sharing so adapter.completed and sandbox.completed events use the SAME id per execute() call.
- `@agentoctopus/gateway`: admin debug endpoint GET /agent/debug/last-run; DebugTelemetryBuffer (per-request RunRecord aggregation by traceId, executionId-based runs[] merge, ring-buffer eviction); /ask correlation-key extraction ([trace: oct-e2e-<uuid>]) with exactly-one terminal emission; per-skill validators for weather (temperature pattern) and ip-lookup (IPv4 pattern).
- `@agentoctopus/cli`: `octopus doctor` subcommand for environment diagnostics.
- `@agentoctopus/sandbox`: bootstrap egress proxy integration; vendored undici for proxy HTTP forwarding.

Co-Authored-By: Claude Sonnet 4.6 <noreply@anthropic.com>
