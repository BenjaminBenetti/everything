# syntax=docker/dockerfile:1
# Helm, which upgrade Jobs run. Each architecture's archive is checked against Helm's published SHA-256.
FROM node:24.21.0-bookworm-slim AS helm
ARG TARGETARCH
ARG HELM_VERSION=v4.3.0
ADD https://get.helm.sh/helm-${HELM_VERSION}-linux-${TARGETARCH}.tar.gz /tmp/helm.tar.gz
RUN case "$TARGETARCH" in \
      amd64) checksum=86584a54def73570558f66f5111cc53dfed56689637ae32c1201205d494f54fb ;; \
      arm64) checksum=31c5794dd55c66a51e6b7d2e2ac7a114ae8b1de41ff1d9ba51748ac973b06a08 ;; \
      *) echo "No Helm checksum for $TARGETARCH" >&2; exit 1 ;; \
    esac; \
    echo "$checksum  /tmp/helm.tar.gz" | sha256sum -c - && \
    tar -xzf /tmp/helm.tar.gz -C /tmp && \
    install -m 0755 "/tmp/linux-$TARGETARCH/helm" /usr/local/bin/helm

FROM node:24.21.0-bookworm-slim AS build
WORKDIR /app
RUN corepack enable
COPY package.json pnpm-lock.yaml pnpm-workspace.yaml ./
COPY lib/errors/package.json ./lib/errors/package.json
COPY lib/security/package.json ./lib/security/package.json
COPY lib/upgrade-contracts/package.json ./lib/upgrade-contracts/package.json
COPY services/upgrader/package.json ./services/upgrader/package.json
RUN --mount=type=secret,id=proxy_ca \
    if [ -f /run/secrets/proxy_ca ]; then export NODE_EXTRA_CA_CERTS=/run/secrets/proxy_ca; fi; \
    pnpm --filter @everything/upgrader... install --frozen-lockfile
COPY tsconfig.base.json ./
COPY services/upgrader/tsconfig.json services/upgrader/tsconfig.build.json ./services/upgrader/
COPY services/upgrader/src ./services/upgrader/src
COPY lib/errors ./lib/errors
COPY lib/security ./lib/security
COPY lib/upgrade-contracts ./lib/upgrade-contracts
RUN pnpm --filter @everything/upgrader... build
RUN --mount=type=secret,id=proxy_ca \
    if [ -f /run/secrets/proxy_ca ]; then export NODE_EXTRA_CA_CERTS=/run/secrets/proxy_ca; fi; \
    pnpm --filter @everything/upgrader deploy --prod /output

FROM node:24.21.0-bookworm-slim
# Helm uses the system CA store to verify HTTPS chart registries.
RUN apt-get update && apt-get install -y --no-install-recommends ca-certificates \
    && rm -rf /var/lib/apt/lists/*
ENV NODE_ENV=production
WORKDIR /app
COPY --from=helm /usr/local/bin/helm /usr/local/bin/helm
COPY --from=build /output ./
USER 1000:1000
EXPOSE 8080
CMD ["node", "build/application/bootstrap/main.js"]
