# ── Stage 1: Build ────────────────────────────────────────────
FROM node:20-slim AS build

WORKDIR /app

# Enable pnpm via corepack
RUN corepack enable

# Copy workspace configuration first for layer caching
COPY package.json pnpm-workspace.yaml pnpm-lock.yaml ./
COPY packages/registry/package.json packages/registry/
COPY packages/adapters/package.json packages/adapters/
COPY packages/core/package.json packages/core/
COPY packages/gateway/package.json packages/gateway/
COPY packages/agentoctopus/package.json packages/agentoctopus/
COPY apps/cli/package.json apps/cli/
COPY apps/web/package.json apps/web/

RUN pnpm install --frozen-lockfile

# Copy source and build
COPY tsconfig.json ./
COPY packages/ packages/
COPY apps/ apps/
COPY registry/ registry/

RUN pnpm build

# ── Stage 2a: Cloud ──────────────────────────────────────────
FROM node:20-slim AS cloud

WORKDIR /app
RUN corepack enable

COPY --from=build /app/package.json /app/pnpm-workspace.yaml /app/pnpm-lock.yaml ./
COPY --from=build /app/node_modules/ node_modules/
COPY --from=build /app/packages/ packages/
COPY --from=build /app/apps/ apps/
COPY --from=build /app/registry/ registry/

ENV DEPLOY_MODE=cloud
ENV NODE_ENV=production

EXPOSE 3000 3002

CMD ["node", "packages/gateway/dist/bin/start-agent-gateway.js"]

# ── Stage 2b: Local ──────────────────────────────────────────
FROM node:20-slim AS local

WORKDIR /app
RUN corepack enable

COPY --from=build /app/package.json /app/pnpm-workspace.yaml /app/pnpm-lock.yaml ./
COPY --from=build /app/node_modules/ node_modules/
COPY --from=build /app/packages/ packages/
COPY --from=build /app/apps/cli/ apps/cli/
COPY --from=build /app/registry/ registry/

ENV DEPLOY_MODE=local
ENV NODE_ENV=production

EXPOSE 3002

CMD ["node", "packages/gateway/dist/bin/start-agent-gateway.js"]
