# FR-CON-006/007: synthetic acceptance fixture. Its build context is allowlisted.
FROM node:24.22.3-bookworm-slim@sha256:873f586f3794f52281bd039bf02c048a0be08fde619338f9941bad1eb6b34530
WORKDIR /fixture
COPY scripts ./scripts
COPY packages ./packages
COPY tests ./tests
COPY node_modules ./node_modules
USER 1001:2000
ENTRYPOINT ["node", "scripts/xlsx-isolation/service.mjs"]
