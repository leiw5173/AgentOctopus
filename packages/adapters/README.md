# @agentoctopus/adapters

Skill execution adapters for AgentOctopus: HTTP, MCP stdio, and subprocess.

## Install

```bash
npm install @agentoctopus/adapters
```

## Usage

Adapters execute a skill given its manifest and an input payload. You typically don't use adapters directly — the `@agentoctopus/core` executor picks the right one automatically. But you can use them standalone if needed.

### HTTP adapter

Calls a remote HTTP endpoint with a JSON body:

```ts
import { HttpAdapter } from '@agentoctopus/adapters';

const adapter = new HttpAdapter();
const result = await adapter.execute(skill, { query: 'hello' });
// result.output — raw response string
```

The skill manifest must have `adapter: http` and a valid `endpoint` URL.

### MCP adapter

Spawns an MCP server over stdio and calls a tool on it:

```ts
import { McpAdapter } from '@agentoctopus/adapters';

const adapter = new McpAdapter();
const result = await adapter.execute(skill, { query: 'hello' });
```

The skill manifest must have `adapter: mcp` and a `command` field pointing to the MCP server binary.

### Subprocess adapter

Runs a local `scripts/invoke.js` file, passing input via the `OCTOPUS_INPUT` environment variable:

```ts
import { SubprocessAdapter } from '@agentoctopus/adapters';

const adapter = new SubprocessAdapter();
const result = await adapter.execute(skill, { query: 'hello' });
```

The skill folder must contain `scripts/invoke.js`. The script reads `process.env.OCTOPUS_INPUT` (a JSON string) and writes its result to stdout as JSON: `{ result: '...' }`.

Example `scripts/invoke.js`:

```js
const input = JSON.parse(process.env.OCTOPUS_INPUT);
const { query } = input;
// ... do work ...
console.log(JSON.stringify({ result: 'answer here' }));
```

## License

Apache 2.0
