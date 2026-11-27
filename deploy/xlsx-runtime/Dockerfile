# EXEC-045. Build from the generated, allowlisted decoder context.
FROM node:24.22.3-bookworm-slim@sha256:873f586f3794f52281bd039bf02c048a0be08fde619338f9941bad1eb6b34530 AS files
RUN rm -rf /usr/local/lib/node_modules /opt/yarn-v1.22.22 && \
    rm -f /usr/local/bin/npm /usr/local/bin/npx /usr/local/bin/corepack \
          /usr/local/bin/yarn /usr/local/bin/yarnpkg /usr/local/bin/pnpm /usr/local/bin/pnpx \
          /usr/local/bin/docker-entrypoint.sh && \
    install -d -m 0755 -o root -g root /run/pdaa-xlsx

FROM scratch
COPY --from=files / /
COPY runtime/ /app/
ENV PATH=/usr/local/bin:/usr/bin:/bin
ENV NODE_ENV=production
WORKDIR /app
USER 1001:2000
HEALTHCHECK --interval=10s --timeout=3s --start-period=5s CMD ["node", "scripts/xlsx-runtime/readiness.mjs"]
ENTRYPOINT ["node", "scripts/xlsx-runtime/service.mjs"]
