# Sync Output Optimization — Design Spec

**Date**: 2026-04-25
**Status**: Approved

## Problem

`octopus sync` output is noisy and unreadable. Phase 2 prints 4000+ lines for "already installed" skills, burying any actual changes. Phase 3 lists every skipped skill by name. There is no unified summary — the user must read through thousands of lines to understand what the sync accomplished.

## Requirements

1. **Show only changes** — added, updated, deleted, and failed skills. Suppress unchanged ("already installed"/"skipped") lines.
2. **Remove progress counter** — no `[N/Total]` prefix in Phase 2.
3. **Unified footer** — single summary line combining all phases: `Sync: N added, N updated, N deleted, N unchanged, N failed`.
4. **Auto-delete stale skills** — skills present locally but absent from the ClaWHub index are deleted without confirmation.
5. **"Updated" label for patch** — skills that already exist but were missing scripts/files are shown as "updated".
6. **Phase-level summaries** — each phase prints its own compact summary after execution.
7. **Rating sync** — same principle: only changes visible, aggregated counts.

## Target Output

### Phase 1 — Marketplace version check

Keep as-is (already minimal — only shows skills with version differences). Phase 1 results feed into Phase 1 install and the unified footer.

### Phase 2 — Awesome bulk install

```
  Syncing awesome skills...
  ✔ slug1 (new)
  ✔ slug2 (updated — filled 11 missing scripts)
  ✘ slug3 (deleted — removed from registry)
  ✘ slug4 — download failed (404)

  Phase 2: 1 added, 1 updated, 1 deleted, 1 failed, 4454 unchanged
```

Rules:
- `✔ green (new)` — first-time install
- `✔ green (updated — ...)` — patched with missing scripts/files, or version-updated
- `✘ red (deleted — removed from registry)` — local skill not in index, deleted
- `✘ red — <error>` — failed install
- All "already installed" lines suppressed

### Phase 3 — Cloud sync

```
  Cloud (example.com): 2 added, 0 updated, 1 error, 140 skipped
```

Rules:
- Only the summary is shown. Individual added/updated/error names are suppressed (cloud sync typically has small counts).
- If there are zero for a category, omit it (e.g. no "0 errors").

### Unified Footer

```
━━━━━━━━━━━━━━━━━━━━━━━━━━━━
Sync: 3 added, 7 updated, 2 deleted, 4593 unchanged, 24 failed
```

Rules:
- Combines all phases.
- If a category is zero, it may be shown or omitted. "Unchanged" is always shown for clarity.
-Only printed when at least one phase ran (i.e., not `--check`).

### Rating sync

Same pattern: suppress "up to date" noise, show only changes, conclude with a compact summary line.

## Implementation Scope

| File | Changes |
|------|---------|
| `apps/cli/src/sync-skills.ts` | Phase 2 — suppress unchanged lines, track deleted, add phase summary |
| `apps/cli/src/sync-skills.ts` | Phase 3 — replace per-skill lines with summary only |
| `apps/cli/src/sync-skills.ts` | Orchestrator (`runSync`) — track deleted count, add unified footer |
| `apps/cli/src/rating-sync.ts` | Apply same "show changes only" principle |
| `apps/cli/tests/sync-skills.test.ts` | Update tests for new output format |

## Non-Goals

- Changing the substance of what sync does (same fetch, same install, same patch logic)
- Adding interactive prompts (deletion is automatic, no confirmation)
- Changing `--check` behavior
- Changing `--dry-run` behavior
- Changing `--debug` output format
