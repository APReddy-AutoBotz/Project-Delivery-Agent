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
RUN pnpm install --frozen-lockfile
COPY apps ./apps
COPY packages ./packages
RUN pnpm build
RUN pnpm --filter @pdaa/api deploy --prod /out/api && pnpm --filter @pdaa/worker deploy --prod /out/worker
COPY scripts/inspect-runtime.mjs ./scripts/inspect-runtime.mjs
RUN node scripts/inspect-runtime.mjs /out/api && node scripts/inspect-runtime.mjs /out/worker

FROM node:24.19.0-bookworm-slim@sha256:a9f5f7c91a432850b2a8a7797adf5eadb6c733ceed61167806cee7ea7fbc29df AS runtime
ENV NODE_ENV=production
USER node
WORKDIR /app

FROM runtime AS api
COPY --from=build --chown=node:node /out/api ./
CMD ["node", "dist/main.js"]

FROM runtime AS worker
COPY --from=build --chown=node:node /out/worker ./
CMD ["node", "dist/main.js"]

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
