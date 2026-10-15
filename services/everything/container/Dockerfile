# syntax=docker/dockerfile:1
# The Docker CLI and Buildx, static builds that fleetd runs against the docker sidecar's engine.
FROM docker:29.8.2-cli AS docker

FROM node:24.21.0-bookworm-slim AS build
WORKDIR /app
RUN corepack enable
COPY package.json pnpm-lock.yaml pnpm-workspace.yaml ./
COPY lib/persistence/package.json ./lib/persistence/package.json
COPY lib/errors/package.json ./lib/errors/package.json
COPY lib/security/package.json ./lib/security/package.json
COPY lib/agent-contracts/package.json ./lib/agent-contracts/package.json
COPY lib/conversation-contracts/package.json ./lib/conversation-contracts/package.json
COPY lib/provider-contracts/package.json ./lib/provider-contracts/package.json
COPY lib/artifact-contracts/package.json ./lib/artifact-contracts/package.json
COPY lib/settings-contracts/package.json ./lib/settings-contracts/package.json
COPY lib/workspace-contracts/package.json ./lib/workspace-contracts/package.json
COPY lib/update-contracts/package.json ./lib/update-contracts/package.json
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
COPY lib/conversation-contracts ./lib/conversation-contracts
COPY lib/provider-contracts ./lib/provider-contracts
COPY lib/artifact-contracts ./lib/artifact-contracts
COPY lib/settings-contracts ./lib/settings-contracts
COPY lib/workspace-contracts ./lib/workspace-contracts
COPY lib/update-contracts ./lib/update-contracts
RUN pnpm --filter @everything/everything... build
RUN --mount=type=secret,id=proxy_ca \
    if [ -f /run/secrets/proxy_ca ]; then export NODE_EXTRA_CA_CERTS=/run/secrets/proxy_ca; fi; \
    pnpm --filter @everything/everything deploy --prod /output

FROM node:24.21.0-bookworm-slim
# fleetd runs in this container, downloaded at startup in the version the chart pins. It needs Git for
# repository checkouts, Docker and the devcontainer CLI for image builds, and tmux for its terminal UI.
RUN apt-get update && apt-get install -y --no-install-recommends \
      # Init that reaps the commands fleetd leaves behind.
      tini \
      ca-certificates git openssh-client tmux \
    && rm -rf /var/lib/apt/lists/*
COPY --from=docker /usr/local/bin/docker /usr/local/bin/docker
COPY --from=docker /usr/local/libexec/docker/cli-plugins/docker-buildx /usr/local/libexec/docker/cli-plugins/docker-buildx
RUN --mount=type=secret,id=proxy_ca \
    if [ -f /run/secrets/proxy_ca ]; then export NODE_EXTRA_CA_CERTS=/run/secrets/proxy_ca; fi; \
    npm install --global --no-audit --no-fund --no-update-notifier @devcontainers/cli@0.89.0
# `fleet` in a shell, such as kubectl exec, reaches the daemon Everything runs.
COPY --chmod=755 services/everything/container/fleet /usr/local/bin/fleet
# OpenSSH finds ~/.ssh through the account's home directory, not $HOME. Make it Fleet's home, the
# chart's fleet volume, so the host keys a user accepts for Fleet's clones, and any SSH key they add
# there, persist; Everything keeps its own HOME below.
RUN usermod --home /fleet node
ENV NODE_ENV=production HOME=/state/home
WORKDIR /app
COPY --from=build /output ./
USER 1000:1000
EXPOSE 8080
ENTRYPOINT ["/usr/bin/tini", "--"]
CMD ["node", "build/application/bootstrap/main.js"]
