# syntax=docker/dockerfile:1
FROM node:24.21.0-bookworm-slim AS build
WORKDIR /app
RUN corepack enable
COPY package.json pnpm-lock.yaml pnpm-workspace.yaml ./
COPY lib/errors/package.json ./lib/errors/package.json
COPY lib/workspace-contracts/package.json ./lib/workspace-contracts/package.json
COPY services/teammate/package.json ./services/teammate/package.json
RUN --mount=type=secret,id=proxy_ca \
    if [ -f /run/secrets/proxy_ca ]; then export NODE_EXTRA_CA_CERTS=/run/secrets/proxy_ca; fi; \
    pnpm --filter @everything/teammate... install --frozen-lockfile
COPY tsconfig.base.json ./
COPY lib/errors ./lib/errors
COPY lib/workspace-contracts ./lib/workspace-contracts
COPY services/teammate ./services/teammate
RUN pnpm --filter @everything/teammate... build
RUN --mount=type=secret,id=proxy_ca \
    if [ -f /run/secrets/proxy_ca ]; then export NODE_EXTRA_CA_CERTS=/run/secrets/proxy_ca; fi; \
    pnpm --filter @everything/teammate deploy --prod /output

FROM node:24.21.0-bookworm-slim
RUN apt-get update && apt-get install -y --no-install-recommends tini && rm -rf /var/lib/apt/lists/*
ENV NODE_ENV=production HOME=/workspace
WORKDIR /app
COPY --from=build /output ./
USER 1000:1000
EXPOSE 8080
ENTRYPOINT ["/usr/bin/tini", "--"]
CMD ["node", "build/application/bootstrap/main.js"]
