# Conventions

## Commit message format

```
<type>(<scope>): <short summary>

<optional body — explain why, not what>
```

**Types:** `feat`, `fix`, `docs`, `refactor`, `test`, `chore`

**Scopes:** `core`, `registry`, `adapters`, `gateway`, `web`, `cli`, or the skill name (e.g., `weather`)

**Examples:**

```
feat(registry): add my-skill with subprocess adapter

fix(core): handle empty embedding response in router

docs(contributing): add smoke-test instructions
```

## Do not commit

- `dist/` — generated build output
- `.env` — credentials
- `registry/ratings.json` — runtime state, changes on every invocation

## PR description

Every PR should explain **what** changed and **why**. For skill PRs, also include the smoke-test output.

## Code of conduct

See [CODE_OF_CONDUCT.md](../../CODE_OF_CONDUCT.md).

## Getting help

- **GitHub issues** — bug reports, feature requests, questions
- **[Architecture](../introduction/how-it-works.md)** — package structure, request flow
- **[API Reference](../api-reference/rest-api.md)** — REST endpoints and agent protocol

See also: [Adding Skills](adding-skills.md) | [Core Engine](core-engine.md)
