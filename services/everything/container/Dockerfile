# syntax=docker/dockerfile:1
FROM node:24.21.0-bookworm-slim AS build
WORKDIR /app
RUN corepack enable
COPY package.json pnpm-lock.yaml pnpm-workspace.yaml ./
COPY lib/persistence/package.json ./lib/persistence/package.json
COPY lib/errors/package.json ./lib/errors/package.json
COPY lib/security/package.json ./lib/security/package.json
COPY lib/agent-contracts/package.json ./lib/agent-contracts/package.json
COPY lib/provider-contracts/package.json ./lib/provider-contracts/package.json
COPY lib/artifact-contracts/package.json ./lib/artifact-contracts/package.json
COPY services/everything/package.json ./services/everything/package.json
COPY services/keycloak/package.json ./services/keycloak/package.json
COPY services/postgres/package.json ./services/postgres/package.json
COPY testing/api/package.json ./testing/api/package.json
RUN --mount=type=secret,id=proxy_ca \
    if [ -f /run/secrets/proxy_ca ]; then export NODE_EXTRA_CA_CERTS=/run/secrets/proxy_ca; fi; \
    pnpm --filter @everything/everything... install --frozen-lockfile
COPY tsconfig.base.json ./
COPY services/everything/tsconfig.json services/everything/tsconfig.build.json ./services/everything/
COPY services/everything/src ./services/everything/src
COPY lib/persistence ./lib/persistence
COPY lib/errors ./lib/errors
COPY lib/security ./lib/security
COPY lib/agent-contracts ./lib/agent-contracts
COPY lib/provider-contracts ./lib/provider-contracts
COPY lib/artifact-contracts ./lib/artifact-contracts
RUN pnpm --filter @everything/everything... build
RUN --mount=type=secret,id=proxy_ca \
    if [ -f /run/secrets/proxy_ca ]; then export NODE_EXTRA_CA_CERTS=/run/secrets/proxy_ca; fi; \
    pnpm --filter @everything/everything deploy --prod /output

FROM node:24.21.0-bookworm-slim
ENV NODE_ENV=production HOME=/state/home
WORKDIR /app
COPY --from=build /output ./
USER 1000:1000
EXPOSE 8080
CMD ["node", "build/application/bootstrap/main.js"]
