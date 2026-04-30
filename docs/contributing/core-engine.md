# Core Engine

Changes to routing logic, adapters, the gateway, the CLI, or the web application are **trust-gated**. Maintainer review takes longer than for skill PRs.

## Before you start

Open a GitHub issue describing the problem and proposed solution. Wait for a maintainer to acknowledge before starting work. This prevents duplicated effort and ensures the change fits the project direction.

## Branch naming

```bash
git checkout master && git pull
git checkout -b feat/<topic>   # for new features
git checkout -b fix/<topic>    # for bug fixes
```

Never commit directly to master.

## Requirements

- All existing tests must continue to pass
- New behavior must be covered by new tests
- Update `README.md` and `TEST_INSTRUCTIONS.md` wherever the change affects documented behavior

## Review

A maintainer must sign off before the PR is merged. Plan for a longer review cycle than skill PRs.

## CI on pull requests

| Job | What it does |
|---|---|
| Changeset Check | Requires a `.changeset/*.md` file. Skipped for docs/CI-only changes, dependabot PRs, or `skip-changeset` label. |
| Lint | `pnpm -r lint` across all workspaces. Runs first; build and test skip if this fails. |
| Build | `pnpm -r --workspace-concurrency=1 build` in topological order. Artifact uploaded for the test job. |
| Test | `pnpm -r test` using restored build artifacts. |

For skill PRs, a maintainer will also run the smoke-test command locally after CI passes.

## Release Process

Pushes to `master` trigger `release-preflight.yml` automatically:
validates the version is not already on npm, runs full audit (lint + build + test),
packs all 7 package tarballs, and uploads them as a preflight artifact.

To actually publish, a maintainer manually dispatches `release-publish.yml` from the
Actions tab, providing the preflight run ID. This publishes all 7 packages in
dependency order (skills → registry → adapters → core → gateway → cli → agentoctopus)
with retry, then creates a GitHub Release from the changelog.

See also: [Adding Skills](adding-skills.md) | [Conventions](conventions.md)
