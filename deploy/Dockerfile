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

FROM node:24.19.0-bookworm-slim@sha256:a9f5f7c91a432850b2a8a7797adf5eadb6c733ceed61167806cee7ea7fbc29df AS runtime-files
# These package managers are build tools. Keep Node's /usr/local/LICENSE intact.
RUN rm -rf /usr/local/lib/node_modules /opt/yarn-v1.22.22 && \
    rm -f /usr/local/bin/npm /usr/local/bin/npx /usr/local/bin/corepack \
          /usr/local/bin/yarn /usr/local/bin/yarnpkg /usr/local/bin/pnpm /usr/local/bin/pnpx

# Copy the cleaned filesystem into a new layer graph: removed tools must not
# remain in inherited lower layers of the customer API/worker images.
FROM scratch AS runtime
COPY --from=runtime-files / /
ENV PATH=/usr/local/sbin:/usr/local/bin:/usr/sbin:/usr/bin:/sbin:/bin
ENV NODE_VERSION=24.19.0
ENV NODE_ENV=production
USER node
WORKDIR /app
ENTRYPOINT ["docker-entrypoint.sh"]

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
COPY --from=runtime /usr/local/LICENSE /usr/local/share/doc/node/LICENSE
WORKDIR /app
COPY --from=build --chown=1000:1000 /out/operations ./
COPY --chown=1000:1000 packages/data/prisma/migrations ./migrations
RUN node --version && pg_dump --version && pg_restore --version
USER 1000:1000
ENV NODE_ENV=production
ENTRYPOINT ["node", "dist/main.js"]

# NFR-SEC-003/010: retain the Caddy release and modules with a pinned Go toolchain.
FROM golang:1.26.8-alpine3.23@sha256:33ce311e5eecedee48ec1b84419c1306e9fbd71009f0d5c3f2a6904b579c1ecc AS web-build
ENV GOTOOLCHAIN=local CGO_ENABLED=0 GOBIN=/out
RUN go test crypto/tls -run '^(TestKeyUpdateSpamPostHandshakeTLS13|TestMultipleKeyUpdate)$' -count=1 -timeout=60s
RUN go install -trimpath -tags nobadger,nomysql,nopgx -ldflags '-X github.com/caddyserver/caddy/v2.CustomVersion=v2.11.4' github.com/caddyserver/caddy/v2/cmd/caddy@v2.11.4
RUN mkdir -p /out/notices/go && \
    cp /usr/local/go/LICENSE /out/notices/go/LICENSE && \
    cp /go/pkg/mod/github.com/caddyserver/caddy/v2@v2.11.4/LICENSE /out/notices/LICENSE && \
    go version -m /out/caddy && test "$(/out/caddy version)" = v2.11.4

FROM caddy:2.11.4-alpine@sha256:5f5c8640aae01df9654968d946d8f1a56c497f1dd5c5cda4cf95ab7c14d58648 AS web-files
RUN rm /usr/bin/caddy
COPY --from=web-build /out/caddy /usr/bin/caddy
COPY --from=web-build /out/notices/ /usr/share/caddy/

# A fresh graph prevents the replaced publisher binary surviving in lower layers.
FROM scratch AS web
COPY --from=web-files / /
ENV PATH=/usr/local/sbin:/usr/local/bin:/usr/sbin:/usr/bin:/sbin:/bin
ENV CADDY_VERSION=v2.11.4 XDG_CONFIG_HOME=/config XDG_DATA_HOME=/data
WORKDIR /srv
COPY --from=build /workspace/apps/web/dist /srv
COPY deploy/Caddyfile /etc/caddy/Caddyfile
CMD ["caddy", "run", "--config", "/etc/caddy/Caddyfile", "--adapter", "caddyfile"]

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
