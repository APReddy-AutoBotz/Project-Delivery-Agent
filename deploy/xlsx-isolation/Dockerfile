# FR-CON-006/007: synthetic acceptance fixture. Its build context is allowlisted.
FROM node:24.19.0-bookworm-slim@sha256:a9f5f7c91a432850b2a8a7797adf5eadb6c733ceed61167806cee7ea7fbc29df
WORKDIR /fixture
COPY scripts ./scripts
COPY tests ./tests
COPY node_modules ./node_modules
USER 1001:2000
ENTRYPOINT ["node", "scripts/xlsx-isolation/service.mjs"]
