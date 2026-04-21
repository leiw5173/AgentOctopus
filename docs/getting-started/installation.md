# Installation

## npm (recommended)

```bash
npm install -g agentoctopus
```

This installs the CLI (`octopus`) and all packages.

## Individual packages

```bash
npm install -g @agentoctopus/cli       # CLI only
npm install -g @agentoctopus/gateway   # IM bots + agent protocol
npm install -g @agentoctopus/core      # Router + executor + LLM client
```

## From source

```bash
git clone https://github.com/leiw5173/AgentOctopus.git
cd AgentOctopus
pnpm install
pnpm build
```

## Docker

```bash
docker compose --profile local up --build
```

See [Docker deployment](../deployment/docker.md) for cloud mode and configuration options.

## Verify installation

```bash
octopus list
# Should show: weather, translation, ip-lookup, x-search
```

## Requirements

- **Node.js 22+** for CLI and gateway
- **pnpm** for building from source (`npm install -g pnpm`)

See also: [Configuration](configuration.md) | [Quick Start](quick-start.md)
