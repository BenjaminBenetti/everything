# syntax=docker/dockerfile:1
# Node.js 24.22.3 LTS on Debian bookworm, pinned by digest, in both stages. Node 24.22.1 and later fix
# CVE-2026-111497, an out-of-bounds write in Node's Brotli decoder.
FROM node:24.22.3-bookworm-slim@sha256:dc26ae92c9fb15cf6b1d63e20f0944b2efe0f115b20e00be48fb23fceb061c54 AS build
WORKDIR /app
RUN corepack enable
COPY package.json pnpm-lock.yaml pnpm-workspace.yaml tsconfig.base.json ./
COPY lib ./lib
COPY services/ui ./services/ui
RUN --mount=type=secret,id=proxy_ca \
    if [ -f /run/secrets/proxy_ca ]; then export NODE_EXTRA_CA_CERTS=/run/secrets/proxy_ca; fi; \
    pnpm --filter @everything/ui-service... install --frozen-lockfile
RUN pnpm --filter @everything/ui-service... build
RUN --mount=type=secret,id=proxy_ca \
    if [ -f /run/secrets/proxy_ca ]; then export NODE_EXTRA_CA_CERTS=/run/secrets/proxy_ca; fi; \
    pnpm --filter @everything/ui-service deploy --prod /output

FROM node:24.22.3-bookworm-slim@sha256:dc26ae92c9fb15cf6b1d63e20f0944b2efe0f115b20e00be48fb23fceb061c54
ENV NODE_ENV=production
WORKDIR /app
COPY --from=build /output ./
USER 1000:1000
EXPOSE 8080
CMD ["node", "build/server/application/bootstrap/server.js"]
