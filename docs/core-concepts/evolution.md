# Skill Evolution

AgentOctopus includes a self-improvement system that automatically analyzes skill performance and proposes targeted improvements.

## How it works

```
Execution signals + user feedback
        │
        ▼
  Collector (aggregates signals per skill)
        │
        ▼
  Analyzer (LLM-driven diagnosis)
        │
        ▼
  Proposal (safe or risky)
        │
   ┌────┴────┐
   ▼         ▼
 Auto-apply  Review required
 (safe)      (risky)
   │
   ▼
 Shadow-copy snapshot → rollback available
```

### Signal collection

The collector aggregates execution signals — success/failure rates, user feedback, and latency — since the last evolution cycle. Skills with degraded performance or negative feedback are flagged for analysis.

### Analysis

The analyzer uses your configured LLM to diagnose issues. It receives the skill's SKILL.md, recent signals, and the current description/instructions, then produces a proposal with specific changes and an evidence trail.

### Proposals

Proposals are classified as **safe** (description-only changes, tag updates) or **risky** (instruction rewrites, structural changes). Safe changes are applied automatically; risky changes require manual review.

### Rollback

Before any change is applied, the system creates a shadow copy snapshot. Snapshots use monotonic sequence numbers and can be listed and rolled back at any time.

## CLI commands

```bash
octopus evolve                          # show evolution status for all skills
octopus evolve --propose weather        # manually trigger analysis for a skill
octopus evolve --review                 # review pending risky proposals
octopus evolve --log weather            # show snapshot history
octopus evolve --rollback weather --to 2  # roll back to snapshot #2
```

## Enabling evolution

Evolution is opt-in. During `octopus onboard`, you'll be asked whether to enable it. You can also enable it manually:

```json
{
  "evolution": {
    "enabled": true
  }
}
```

in `~/.agentoctopus/octopus.json`.

See also: [Skills](skills.md) | [Rating System](ratings.md) | [CLI Reference](../api-reference/cli-reference.md)
