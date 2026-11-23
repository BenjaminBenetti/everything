# syntax=docker/dockerfile:1
# Node.js 24.22.3 LTS on Debian bookworm, pinned by digest, in both stages. Node 24.22.1 and later fix
# CVE-2026-111497, an out-of-bounds write in Node's Brotli decoder.
FROM node:24.22.3-bookworm-slim@sha256:dc26ae92c9fb15cf6b1d63e20f0944b2efe0f115b20e00be48fb23fceb061c54 AS build
WORKDIR /app
RUN corepack enable
COPY package.json pnpm-lock.yaml pnpm-workspace.yaml ./
COPY lib/persistence/package.json ./lib/persistence/package.json
COPY lib/errors/package.json ./lib/errors/package.json
COPY lib/security/package.json ./lib/security/package.json
COPY lib/artifact-contracts/package.json ./lib/artifact-contracts/package.json
COPY services/artifact/package.json ./services/artifact/package.json
RUN --mount=type=secret,id=proxy_ca \
    if [ -f /run/secrets/proxy_ca ]; then export NODE_EXTRA_CA_CERTS=/run/secrets/proxy_ca; fi; \
    pnpm --filter @everything/artifact... install --frozen-lockfile
COPY tsconfig.base.json ./
COPY services/artifact/tsconfig.json services/artifact/tsconfig.build.json ./services/artifact/
COPY services/artifact/src ./services/artifact/src
COPY lib/persistence ./lib/persistence
COPY lib/errors ./lib/errors
COPY lib/security ./lib/security
COPY lib/artifact-contracts ./lib/artifact-contracts
RUN pnpm --filter @everything/artifact... build
RUN --mount=type=secret,id=proxy_ca \
    if [ -f /run/secrets/proxy_ca ]; then export NODE_EXTRA_CA_CERTS=/run/secrets/proxy_ca; fi; \
    pnpm --filter @everything/artifact deploy --prod /output

FROM node:24.22.3-bookworm-slim@sha256:dc26ae92c9fb15cf6b1d63e20f0944b2efe0f115b20e00be48fb23fceb061c54
ENV NODE_ENV=production
WORKDIR /app
COPY --from=build /output ./
USER 1000:1000
EXPOSE 8080 8081
CMD ["node", "build/application/bootstrap/main.js"]
