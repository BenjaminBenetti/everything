# syntax=docker/dockerfile:1
FROM node:24.21.0-bookworm-slim AS build
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

FROM node:24.21.0-bookworm-slim
ENV NODE_ENV=production
WORKDIR /app
COPY --from=build /output ./
USER 1000:1000
EXPOSE 8080
CMD ["node", "build/server/application/bootstrap/server.js"]
