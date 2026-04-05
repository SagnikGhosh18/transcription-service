FROM oven/bun:1 AS base
WORKDIR /app

# Copy entire monorepo so workspace symlinks resolve correctly
COPY . .

# Install all dependencies
RUN bun install

WORKDIR /app/apps/server

EXPOSE 3000

CMD ["bun", "run", "src/index.ts"]
