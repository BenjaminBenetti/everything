# everything

one agent at the center of everything

See [planning](planning/README.md) for the concept, architecture, user surfaces, and interactive UI reference.

The implementation is a pnpm workspace organized by service and container:

```text
lib/
  persistence/     TypeORM entity foundations, scoped repository defaults, transactions
  security/        Verified identity, Keycloak token verification, Fastify authentication
  errors/          Expected application failure contract
  agent-contracts/ Browser-safe agent DTOs and validation limits
  artifact-contracts/ App representations and limits shared by services and the UI
  conversation-contracts/ Browser-safe chat messages, pagination, and progress
  workspace-contracts/ File and shell request schemas and bounded result contracts
  ui/              Shared React controls, branding, and eight-theme design tokens
services/
  everything/      API + main-agent lifecycle + Pi runtime + fleetd supervision
    src/           <domain>/<type>/<file>
    container/     Everything image
  ui/              React + Tailwind PWA and stateless UI host
  artifact/        App records, files, builds, workloads, and hosting
  teammate/        Internal file and Bash API, one always-running pod per teammate
  keycloak/        Authentication: optimized Keycloak image
testing/
  api/             Bruno requests, environments, and assertions
  ui/              Playwright checks against the deployed app and real Keycloak
deployment/
  helm/            The Helm chart: generic templates, one values entry per service, Keycloak realm, PostgreSQL setup, prod values
  cluster/         Namespaces applied before the release
  script/          Local cluster commands, chart checks, restart orchestration
planning/          Architecture documents and archived UI concept
.github/workflows/ CI checks, and tagged releases of images and the chart
```

Everything and Pi share a process and pod because their lifecycle is coupled. Keycloak and PostgreSQL communicate across service boundaries; they do not import Everything's code. Each service under `services/` owns its image, while PostgreSQL, the image registry for apps and Fleet, and the Docker engine sidecar fleetd builds with run their published images unchanged; one Helm chart in `deployment/helm` deploys them all, and adding a service is a values entry (see [adding a service](deployment/documentation/foundation.md#adding-a-service)). Application database migrations belong to Everything. Agents run on the model provider connected through the application; no provider or model is a deployment setting. The UI is a separate stateless Deployment, serving the React/Tailwind app at `/`. The artifact service tracks the apps teammates share, builds and runs dynamic ones, and serves them on an origin of their own (see [apps](deployment/documentation/foundation.md#apps)). fleetd, Fleet's daemon, runs inside Everything's container in the version the chart pins, connected to the cluster, and every teammate gets its MCP tools to run work in Fleet instances (see [Fleet](deployment/documentation/foundation.md#fleet)).

Shared libraries follow the same domain/type structure as services and have specific responsibilities. `@everything/persistence` provides `BaseEntity`, `OwnedEntity`, the `Repository` contract, `OwnerScope`, and an abstract `BaseRepository` with TypeORM-backed lookup/list/delete implementations. `@everything/security` provides the verified `Identity`, `TokenVerifier` contract, Keycloak verification, a Fastify authentication adapter, browser session contracts, the confidential password-grant adapter, and session encryption. `@everything/errors` provides `ApplicationError`. Services consume each library through public package exports and `workspace:*` dependencies. TypeScript packages extend `tsconfig.base.json`; each package's `tsconfig.json` type-checks sources and tests, and `tsconfig.build.json` emits `build/` without tests. See [repository conventions](AGENTS.md) for the rules.

Use Node 24.11+ and pnpm 10.34.6 (`corepack enable`, then `corepack prepare pnpm@10.34.6 --activate`). Building and testing the teammate service also requires Linux and a C compiler (`cc`) for its command supervisor. The devcontainer includes these tools.

```sh
pnpm install --frozen-lockfile
pnpm build           # Compile code, type-check tests, lint and render the Helm chart, check scripts
pnpm test            # All workspace unit tests
pnpm build:images    # Build all service container images
pnpm cluster:up      # Build, load, and deploy the local stack
pnpm cluster:forward # Serve the stack at http://localhost:8080 and apps at :8081
pnpm cluster:down    # Delete the local stack and all of its data (asks first; --yes skips)
pnpm test:api        # Bruno API collection against the local stack
pnpm test:ui         # Desktop/phone browser checks; requires cluster:forward and Chromium
pnpm test:restart    # Bruno checks before and after replacing every pod
pnpm test:all        # Build + checks + unit tests + Bruno + pod-replacement verification
```

The Bruno commands require the deployed Minikube stack; they use a running `cluster:forward`, or forward the ingress themselves. `test:restart` and `test:all` restart all application pods. To work on one service, use `pnpm --filter @everything/everything... build` (or `test`, `start`, `build:image`).

The UI implements welcome, Home, team, teammate chat, updates, and apps surfaces with all eight themes. The welcome form authenticates through the API’s Keycloak back channel. Teammate profiles, avatars, and provider/model/effort selections persist through the API. Each teammate opens one ongoing conversation with paginated saved history, reply progress, and a stop action. Pi automatically compacts older model context into durable summaries without removing visible messages. The Apps page lists the apps teammates share and opens them on the artifact host. Provider connections are configured in the application. Home and Updates list unread updates, starting with messages from teammates, each with a cached one-sentence summary of why it needs attention, durable read receipts, and a link to the original message; push delivery remains deferred. See [frontend setup](services/ui/README.md).

Teammates can use `fork` to start a private background session with the same instructions, provider, model, effort, tools, and workspace. Its `context` parameter defaults to `false`, so it starts with only the assigned task and shared instructions; `context: true` copies the parent's current conversation history. `send_fork_message` exchanges messages using a fork ID, `main`, or `parent`; busy recipients process messages after their current turn. `list_forks` reports private session status, and `stop_fork` stops a descendant and its children. Up to eight forks run concurrently; additional messages wait for a free slot. Bash commands have no application concurrency limit: each runs independently, and completion or interruption cleans up only that command's descendants. Fork replies return to the parent, and only the main session writes to the user's conversation. New user messages leave background work running, while Stop cancels the whole family. Histories live under each teammate's private `.pi/forks/<main-session-id>` directory; after a restart or settings change, messaging a saved fork resumes its history using the main teammate's current settings.

Pushing a semantic version tag such as `v1.2.3` publishes multi-architecture images and the Helm chart to GitHub Container Registry and creates a GitHub release (see [releases](deployment/documentation/foundation.md#releases)). Install or upgrade a cluster with the interactive installer: `curl -fsSL https://github.com/BenjaminBenetti/everything/releases/latest/download/install.sh | bash` (see [deploy to a cluster](deployment/documentation/foundation.md#deploy-to-a-cluster)). After that, Everything upgrades itself from Settings → Version (see [upgrades from Everything](deployment/documentation/foundation.md#upgrades-from-everything)).

See the [setup and review guide](deployment/documentation/foundation.md) for deploying to a cluster, security configuration, API endpoints, persistence, and Bruno instructions.
