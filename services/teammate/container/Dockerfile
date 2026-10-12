# syntax=docker/dockerfile:1
# Toolchains copied into the runtime image. Every stage uses Debian trixie, so the copied builds
# link against the same shared libraries the runtime image installs.
FROM python:3.14.8-slim-trixie AS python
FROM ruby:4.0.7-slim-trixie AS ruby
FROM golang:1.27.2-trixie AS go

FROM node:24.21.0-trixie-slim AS build
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

# The teammate's development environment, which also runs the workspace API.
FROM node:24.21.0-trixie-slim
RUN apt-get update && apt-get install -y --no-install-recommends \
      # Init that reaps commands' orphaned processes.
      tini \
      # Everyday command-line tools.
      ca-certificates curl git jq procps unzip xz-utils zip \
      # C and C++ compilers, make, and the C library headers native packages build against.
      build-essential \
      # Headless browser, with fonts metric-compatible with common web fonts.
      chromium fonts-liberation \
      # Libraries the copied Python and Ruby builds link against that the base image lacks.
      libffi8 libgdbm6t64 libncursesw6 libreadline8t64 libtk8.6 libyaml-0-2 \
    && rm -rf /var/lib/apt/lists/*
COPY --from=python /usr/local/ /usr/local/
COPY --from=ruby /usr/local/ /usr/local/
COPY --from=go /usr/local/go /usr/local/go
# Register the copied shared libraries, fail the build if any copied program misses a library, and
# give UID 1000 the workspace as its home for tools that read the account database instead of HOME.
RUN ldconfig \
    && ! find /usr/local -path /usr/local/go -prune -o -type f \( -name '*.so*' -o -perm -u+x \) -print \
      | xargs ldd 2>/dev/null | grep 'not found' \
    && usermod --home /workspace node
# Pods have no user namespaces or setuid helpers, so Chromium runs without its sandbox. There is no
# display either, so the launcher always runs it headless.
COPY <<'EOF' /etc/chromium.d/teammate
export CHROMIUM_FLAGS="$CHROMIUM_FLAGS --no-sandbox --headless"
EOF
# Commands receive the variables named in src/shell/model/command-environment.ts. HOME is the
# workspace: user-level installs land in its hidden .local directory and persist with its files,
# while download and build caches stay in /tmp, off the shared volume and out of published artifacts.
ENV NODE_ENV=production \
    HOME=/workspace \
    LANG=C.UTF-8 \
    TMPDIR=/tmp \
    PATH=/workspace/.local/bin:/workspace/.local/share/gem/bin:/usr/local/go/bin:/usr/local/sbin:/usr/local/bin:/usr/sbin:/usr/bin:/sbin:/bin \
    XDG_CACHE_HOME=/tmp/cache \
    NPM_CONFIG_PREFIX=/workspace/.local \
    NPM_CONFIG_CACHE=/tmp/cache/npm \
    NPM_CONFIG_UPDATE_NOTIFIER=false \
    PIP_DISABLE_PIP_VERSION_CHECK=1 \
    GEM_HOME=/workspace/.local/share/gem \
    BUNDLE_USER_CACHE=/tmp/cache/bundler \
    GOPATH=/workspace/.local/share/go \
    GOBIN=/workspace/.local/bin \
    GOMODCACHE=/tmp/cache/go-mod \
    CHROME_PATH=/usr/bin/chromium \
    PUPPETEER_EXECUTABLE_PATH=/usr/bin/chromium \
    PUPPETEER_SKIP_DOWNLOAD=true \
    PLAYWRIGHT_SKIP_BROWSER_DOWNLOAD=1 \
    PLAYWRIGHT_MCP_EXECUTABLE_PATH=/usr/bin/chromium
WORKDIR /app
COPY --from=build /output ./
USER 1000:1000
EXPOSE 8080
ENTRYPOINT ["/usr/bin/tini", "--"]
CMD ["node", "build/application/bootstrap/main.js"]
