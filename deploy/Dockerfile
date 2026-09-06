# TR-DEP-001, TR-DEP-003: controlled acceptance images; distribution gates remain open.
FROM node:24.19.0-bookworm-slim@sha256:a9f5f7c91a432850b2a8a7797adf5eadb6c733ceed61167806cee7ea7fbc29df AS build
RUN apt-get update && apt-get install -y --no-install-recommends openssl ca-certificates && rm -rf /var/lib/apt/lists/*
RUN npm install --global pnpm@11.19.0
WORKDIR /workspace
COPY package.json pnpm-lock.yaml pnpm-workspace.yaml .pnpmfile.mjs tsconfig.base.json ./
COPY apps/api/package.json ./apps/api/package.json
COPY apps/web/package.json ./apps/web/package.json
COPY apps/worker/package.json ./apps/worker/package.json
COPY packages/data/package.json ./packages/data/package.json
COPY packages/domain/package.json ./packages/domain/package.json
COPY packages/platform/package.json ./packages/platform/package.json
COPY packages/operations/package.json ./packages/operations/package.json
RUN pnpm install --frozen-lockfile
COPY apps ./apps
COPY packages ./packages
RUN pnpm build
RUN pnpm --filter @pdaa/api deploy --prod /out/api && pnpm --filter @pdaa/worker deploy --prod /out/worker
RUN pnpm --filter @pdaa/operations deploy --prod /out/operations
COPY scripts/inspect-runtime.mjs ./scripts/inspect-runtime.mjs
RUN node scripts/inspect-runtime.mjs /out/api && node scripts/inspect-runtime.mjs /out/worker
RUN node scripts/inspect-runtime.mjs /out/operations

FROM node:24.19.0-bookworm-slim@sha256:a9f5f7c91a432850b2a8a7797adf5eadb6c733ceed61167806cee7ea7fbc29df AS runtime
ENV NODE_ENV=production
USER node
WORKDIR /app

FROM runtime AS api
COPY --from=build --chown=node:node /out/api ./
HEALTHCHECK --interval=10s --timeout=5s --start-period=30s CMD ["node", "-e", "fetch('http://127.0.0.1:3001/api/health/ready',{signal:AbortSignal.timeout(4000)}).then(r=>{process.exitCode=r.ok?0:1}).catch(()=>{process.exitCode=1})"]
CMD ["node", "dist/main.js"]

FROM runtime AS worker
COPY --from=build --chown=node:node /out/worker ./
HEALTHCHECK --interval=10s --timeout=5s CMD ["node", "-e", "process.kill(1,0)"]
CMD ["node", "dist/main.js"]

# Reuse pinned Node and PostgreSQL clients without Prisma CLI/Studio or new npm tools.
FROM pgvector/pgvector:0.8.6-pg17-bookworm@sha256:cf134a767f474095eeba57e0117be8e568e011a63f33fbf252f14c9b760f8e6f AS operations
COPY --from=runtime /usr/local/bin/node /usr/local/bin/node
WORKDIR /app
COPY --from=build --chown=1000:1000 /out/operations ./
COPY --chown=1000:1000 packages/data/prisma/migrations ./migrations
RUN node --version && pg_dump --version && pg_restore --version
USER 1000:1000
ENV NODE_ENV=production
ENTRYPOINT ["node", "dist/main.js"]

FROM caddy:2.11.4-alpine@sha256:5f5c8640aae01df9654968d946d8f1a56c497f1dd5c5cda4cf95ab7c14d58648 AS web
RUN setcap -r /usr/bin/caddy
COPY --from=build /workspace/apps/web/dist /srv
COPY deploy/Caddyfile /etc/caddy/Caddyfile

# Build/test tooling is separate from application images and is not a distributable.
FROM node:24.19.0-bookworm-slim@sha256:a9f5f7c91a432850b2a8a7797adf5eadb6c733ceed61167806cee7ea7fbc29df AS acceptance
RUN apt-get update && apt-get install -y --no-install-recommends openssl ca-certificates && rm -rf /var/lib/apt/lists/*
WORKDIR /workspace
COPY --from=build /workspace/node_modules ./node_modules
COPY --from=build /workspace/apps ./apps
COPY --from=build /workspace/packages ./packages
COPY --from=build /workspace/package.json ./package.json
RUN node node_modules/@playwright/test/cli.js install --with-deps chromium && apt-get update && apt-get install -y --no-install-recommends libnss3-tools && rm -rf /var/lib/apt/lists/*
COPY scripts/acceptance ./scripts/acceptance
CMD ["node", "scripts/acceptance/run.mjs"]
