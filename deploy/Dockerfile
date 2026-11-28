# TR-DEP-001, TR-DEP-003: controlled acceptance images; distribution gates remain open.
FROM node:24.22.3-bookworm-slim@sha256:873f586f3794f52281bd039bf02c048a0be08fde619338f9941bad1eb6b34530 AS build
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
COPY packages/connectors-jira/package.json ./packages/connectors-jira/package.json
COPY packages/operations/package.json ./packages/operations/package.json
COPY packages/reporting/package.json ./packages/reporting/package.json
RUN pnpm install --frozen-lockfile
COPY apps ./apps
COPY packages ./packages
RUN pnpm build
RUN pnpm --filter @pdaa/api deploy --prod /out/api && pnpm --filter @pdaa/worker deploy --prod /out/worker
RUN pnpm --filter @pdaa/operations deploy --prod /out/operations
COPY scripts/inspect-runtime.mjs ./scripts/inspect-runtime.mjs
RUN node scripts/inspect-runtime.mjs /out/api && node scripts/inspect-runtime.mjs /out/worker
RUN node scripts/inspect-runtime.mjs /out/operations

# AC-MNT-004: authenticate only the pinned original source files in a build stage.
FROM node:24.22.3-bookworm-slim@sha256:873f586f3794f52281bd039bf02c048a0be08fde619338f9941bad1eb6b34530 AS node-notice-build
WORKDIR /collector
COPY scripts/package-node-notices.mjs ./scripts/package-node-notices.mjs
COPY scripts/distribution/evidence.mjs scripts/distribution/node-components.mjs scripts/distribution/node-components.json scripts/distribution/node-supplemental.mjs scripts/distribution/node-supplemental.json ./scripts/distribution/
RUN node scripts/package-node-notices.mjs fetch /node-sources
RUN --network=none node scripts/package-node-notices.mjs package /node-sources /out-node-notices

# Only original notices and the source index leave the build stage.
FROM scratch AS node-notices
COPY --from=node-notice-build /out-node-notices/ /

FROM node:24.22.3-bookworm-slim@sha256:873f586f3794f52281bd039bf02c048a0be08fde619338f9941bad1eb6b34530 AS runtime-files
# These package managers are build tools. Keep Node's /usr/local/LICENSE intact.
RUN rm -rf /usr/local/lib/node_modules /opt/yarn-v1.22.22 && \
    rm -f /usr/local/bin/npm /usr/local/bin/npx /usr/local/bin/corepack \
          /usr/local/bin/yarn /usr/local/bin/yarnpkg /usr/local/bin/pnpm /usr/local/bin/pnpx
COPY --from=node-notices / /usr/local/share/doc/node/supplements/

# Copy the cleaned filesystem into a new layer graph: removed tools must not
# remain in inherited lower layers of the customer API/worker images.
FROM scratch AS runtime
COPY --from=runtime-files / /
ENV PATH=/usr/local/sbin:/usr/local/bin:/usr/sbin:/usr/bin:/sbin:/bin
ENV NODE_VERSION=24.22.3
ENV NODE_ENV=production
USER node
WORKDIR /app
ENTRYPOINT ["docker-entrypoint.sh"]

FROM runtime AS api
COPY --from=build --chown=node:node /out/api ./
HEALTHCHECK --interval=10s --timeout=5s --start-period=30s CMD ["node", "-e", "fetch('http://127.0.0.1:3001/api/health/ready',{signal:AbortSignal.timeout(4000)}).then(r=>{process.exitCode=r.ok?0:1}).catch(()=>{process.exitCode=1})"]
CMD ["node", "dist/main.js"]

# EXEC-045: compile the peer check in a separate pinned, offline build stage.
FROM gcc:14.3.0-bookworm@sha256:5e927c284bf55a7dc796262e311a0703344f62f41f5621eb56843111b1d37e15 AS xlsx-bridge-build
WORKDIR /bridge
COPY deploy/xlsx-isolation/peer-bridge.c ./
RUN --network=none gcc -std=c17 -O2 -Wall -Wextra -Werror -fPIE -pie \
    -fstack-protector-strong -D_FORTIFY_SOURCE=2 -Wl,-z,relro,-z,now \
    peer-bridge.c -o pdaa-xlsx-peer-bridge

FROM api AS api-xlsx
COPY --from=xlsx-bridge-build --chown=0:0 --chmod=0555 /bridge/pdaa-xlsx-peer-bridge /usr/local/libexec/pdaa-xlsx-peer-bridge

# Disposable XLSX owner fixture. This test target has no browser dependencies.
FROM build AS xlsx-proof
COPY scripts/acceptance/common.mjs scripts/acceptance/prepare.mjs scripts/acceptance/prepare-customer.mjs scripts/acceptance/xlsx-source-genesis.mjs scripts/acceptance/xlsx-customer-proof.mjs ./scripts/acceptance/
COPY scripts/acceptance/canonical-projects.mjs scripts/acceptance/golden-source-observations.mjs ./scripts/acceptance/
CMD ["node", "scripts/acceptance/xlsx-customer-proof.mjs"]

FROM runtime AS worker
COPY --from=build --chown=node:node /out/worker ./
HEALTHCHECK --interval=10s --timeout=5s CMD ["node", "-e", "process.kill(1,0)"]
CMD ["node", "dist/main.js"]

# Reuse pinned Node and PostgreSQL clients without Prisma CLI/Studio or new npm tools.
FROM pgvector/pgvector:0.8.7-pg17-bookworm@sha256:b513c48566e4777cd3370451400000c78eda6a08131d68f4c31d4a76f27bd8fd AS operations
COPY --from=runtime /usr/local/bin/node /usr/local/bin/node
COPY --from=runtime /usr/local/LICENSE /usr/local/share/doc/node/LICENSE
COPY --from=runtime /usr/local/share/doc/node/supplements/ /usr/local/share/doc/node/supplements/
WORKDIR /app
COPY --from=build --chown=1000:1000 /out/operations ./
COPY --chown=1000:1000 packages/data/prisma/migrations ./migrations
RUN node --version && pg_dump --version && pg_restore --version
USER 1000:1000
ENV NODE_ENV=production
ENTRYPOINT ["node", "dist/main.js"]

# NFR-SEC-003/010: retain the Caddy release and modules with a pinned Go toolchain.
FROM golang:1.26.11-alpine3.23@sha256:23f198931d4bd83b4f5a613bd75656257ae8bf832dcbc2db80e1050b5219ca2a AS web-build
ENV GOTOOLCHAIN=local CGO_ENABLED=0 GOBIN=/out
RUN go test crypto/tls -run '^(TestKeyUpdateSpamPostHandshakeTLS13|TestMultipleKeyUpdate)$' -count=1 -timeout=60s
RUN go install -trimpath -tags nobadger,nomysql,nopgx -ldflags '-X github.com/caddyserver/caddy/v2.CustomVersion=v2.11.9' github.com/caddyserver/caddy/v2/cmd/caddy@v2.11.9
COPY scripts/go-notices /notice-collector
COPY scripts/distribution/caddy-modules.json /notice-collector/caddy-modules.json
# AC-MNT-004: exact compiled sources and original notices, with no network access.
RUN --network=none cd /notice-collector && GO111MODULE=off go test -count=1 -v . && \
    go run main.go -inventory /notice-collector/caddy-modules.json
RUN mkdir -p /out/notices/go && \
    cp /usr/local/go/LICENSE /out/notices/go/LICENSE && \
    cp /go/pkg/mod/github.com/caddyserver/caddy/v2@v2.11.9/LICENSE /out/notices/LICENSE && \
    go version -m /out/caddy && test "$(/out/caddy version)" = v2.11.9

FROM caddy:2.11.9-alpine@sha256:003a97808e781aa9f7e75cc2f43d34d461099031faf5e20faefb9f61126836f0 AS web-files
# Apply the Alpine security updates published after the selected Caddy image.
ADD --checksum=sha256:7b05bc778b8b25cd880835b40114182bd4d1581717504d0129c810c0a14291cb https://dl-cdn.alpinelinux.org/alpine/v3.24/main/x86_64/zlib-1.4-r0.apk /tmp/zlib-1.4-r0.apk
ADD --checksum=sha256:042026082cc9bc7872d1baa81755c50efa70b05f03b5369fdc5f0a1303009720 https://dl-cdn.alpinelinux.org/alpine/v3.24/main/x86_64/libcrypto3-3.5.9-r1.apk /tmp/libcrypto3-3.5.9-r1.apk
ADD --checksum=sha256:18c5778cbe52e1991303f8531970b05d4e6e036ea08349322f7422f42a689dc7 https://dl-cdn.alpinelinux.org/alpine/v3.24/main/x86_64/libssl3-3.5.9-r1.apk /tmp/libssl3-3.5.9-r1.apk
# NFR-SEC-010 / AC-MNT-004: Caddy and the BusyBox health probe do not use curl.
# Resolve orphan libraries offline, preserving the installed-package inventory.
RUN apk add --no-network /tmp/zlib-1.4-r0.apk /tmp/libcrypto3-3.5.9-r1.apk /tmp/libssl3-3.5.9-r1.apk && \
    apk del --no-network curl && \
    rm /tmp/zlib-1.4-r0.apk /tmp/libcrypto3-3.5.9-r1.apk /tmp/libssl3-3.5.9-r1.apk /usr/bin/caddy
COPY --from=web-build /out/caddy /usr/bin/caddy
COPY --from=web-build /out/notices/ /usr/share/caddy/

# A fresh graph excludes the replaced binary and removed transfer-tool payloads.
FROM scratch AS web
COPY --from=web-files / /
ENV PATH=/usr/local/sbin:/usr/local/bin:/usr/sbin:/usr/bin:/sbin:/bin
ENV CADDY_VERSION=v2.11.9 XDG_CONFIG_HOME=/config XDG_DATA_HOME=/data
WORKDIR /srv
COPY --from=build /workspace/apps/web/dist /srv
COPY deploy/Caddyfile /etc/caddy/Caddyfile
CMD ["caddy", "run", "--config", "/etc/caddy/Caddyfile", "--adapter", "caddyfile"]

# Build/test tooling is separate from application images and is not a distributable.
FROM node:24.22.3-bookworm-slim@sha256:873f586f3794f52281bd039bf02c048a0be08fde619338f9941bad1eb6b34530 AS acceptance
RUN apt-get update && apt-get install -y --no-install-recommends openssl ca-certificates && rm -rf /var/lib/apt/lists/*
WORKDIR /workspace
COPY --from=build /workspace/node_modules ./node_modules
COPY --from=build /workspace/apps ./apps
COPY --from=build /workspace/packages ./packages
COPY --from=build /workspace/package.json ./package.json
RUN node node_modules/@playwright/test/cli.js install --with-deps chromium && apt-get update && apt-get install -y --no-install-recommends libnss3-tools && rm -rf /var/lib/apt/lists/*
COPY scripts/acceptance ./scripts/acceptance
CMD ["node", "scripts/acceptance/run.mjs"]
