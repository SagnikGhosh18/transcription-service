FROM oven/bun:1 AS base
WORKDIR /app

# Copy monorepo root manifests
COPY package.json package-lock.json ./

# Copy package manifests for all workspaces
COPY packages/config/package.json   ./packages/config/
COPY packages/db/package.json        ./packages/db/
COPY packages/env/package.json       ./packages/env/
COPY packages/ui/package.json        ./packages/ui/
COPY apps/server/package.json        ./apps/server/

# Install all dependencies
RUN npm install --frozen-lockfile

# Copy source
COPY packages/ ./packages/
COPY apps/server/ ./apps/server/

WORKDIR /app/apps/server

EXPOSE 3000

CMD ["bun", "run", "src/index.ts"]
