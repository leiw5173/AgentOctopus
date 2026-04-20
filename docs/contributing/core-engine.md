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

| Job | Command | Notes |
|---|---|---|
| Lint | `pnpm -r lint` | Runs first; build and test are skipped if this fails |
| Build | `pnpm -r --workspace-concurrency=1 build` | Builds all packages in topological order |
| Test | `pnpm -r test` | Uses build artifacts from the previous job |

For skill PRs, a maintainer will also run the smoke-test command locally after CI passes.

See also: [Adding Skills](adding-skills.md) | [Conventions](conventions.md)
