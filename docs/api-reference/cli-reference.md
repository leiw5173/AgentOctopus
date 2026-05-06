# CLI Reference

All commands are run via the `octopus` CLI after installing `agentoctopus` globally.

## Setup

### `octopus onboard`

Interactive setup wizard. Configures LLM provider, API keys, and copies built-in skills.

### `octopus connect <target>`

Import configuration from a platform (e.g., `openclaw`). Writes LLM config to `octopus.json` v2 format.

### `octopus config set <key> <value>`

Write a credential to `~/.agentoctopus/.env` and update the `${VAR}` reference in `~/.agentoctopus/octopus.json`.

### `octopus config list`

List all stored credentials from `octopus.json` (values masked).

## Query

### `octopus ask <query>`

Route a natural-language query to the best-matching skill. Returns the skill result or a direct LLM answer.

```bash
octopus ask "what's the weather in Tokyo"
octopus ask "translate hello to French"
```

If the selected skill fails (network error, missing API key, 429 rate limit), `octopus ask` automatically tries the next best-matching candidate. It retries up to `maxRetries` times (default: 3, configurable in `~/.agentoctopus/octopus.json`). If all candidates fail and the failure was auth-related, it shows the relevant `octopus config set` command to fix it.

### `octopus list`

Show all installed skills with their names, adapters, and ratings.

## Skill management

### `octopus add <slug>`

Install a skill from ClaWHub by its slug.

### `octopus remove <name>`

Remove an installed skill by name.

### `octopus search <query>`

Search local skills by name, description, and tags. Results are scored and ranked by relevance.

**Options:**

- `--run` — interactively pick a skill from the results and run a query against it

### `octopus publish [dir]`

Publish a skill to the marketplace. Defaults to the current directory.

### `octopus skill create`

AI-assisted skill creation. Walks you through a Q&A, then uses your LLM to generate a `SKILL.md` manifest. For API-based skills it also writes a `scripts/invoke.js` stub.

### `octopus skill create --template`

Write a blank `SKILL.md` and `scripts/invoke.js` immediately — no prompts, no AI.

### `octopus skill list`

List skills (same as `octopus list`).

### `octopus skill add <slug>`

Add a skill (same as `octopus add`).

### `octopus skill remove <name>`

Remove a skill (same as `octopus remove`).

### `octopus skill search <query>`

Search local skills (same as `octopus search`).

### `octopus skill publish [dir]`

Publish a skill (same as `octopus publish`).

## Sync

### `octopus sync`

Check for skill updates and install from the community catalog (5,000+ skills).

**Options:**

- `--check` — check for updates without installing
- `--category <cat>` — filter by category
- `--cloud-url <url>` — also sync from a cloud AgentOctopus instance
- `--force` — overwrite existing skills
- `--setup-gist` — set up GitHub Gist for rating sync
- `--ratings` — bidirectional rating sync
- `--ratings --pull` — pull ratings from cloud
- `--ratings --push` — push ratings to cloud

## Update

### `octopus update`

Check for and install package updates.

**Options:**

- `--check` — check only, don't install

## Server

### `octopus start`

Start the agent gateway on `http://localhost:3002` (port configured via `gateway.port` in `~/.agentoctopus/octopus.json`).

See also: [REST API](rest-api.md) | [Configuration](../getting-started/configuration.md)
