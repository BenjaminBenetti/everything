# everything
one agent at the center of everything

See [planning](planning/README.md) for the concept, architecture, user surfaces, and interactive UI reference.

The implementation is a pnpm workspace organized by service and container:

```text
lib/
  persistence/     TypeORM entity foundations, scoped repository defaults, transactions
  security/        Verified identity, Keycloak token verification, Fastify authentication
  errors/          Expected application failure contract
services/
  everything/      API + main-agent lifecycle + Pi runtime
    src/           <domain>/<type>/<file>
    container/     Everything image
  keycloak/        Authentication: optimized Keycloak image
  postgres/        Database: initialization, access rules, image
testing/
  api/             Bruno requests, environments, and assertions
deployment/
  helm/            The Helm chart: generic templates, one values entry per service, Keycloak realm, prod values
  cluster/         Namespace applied before the release
  script/          Local cluster commands, chart checks, restart orchestration
planning/          Architecture documents and archived UI concept
```

Everything and Pi share a process and pod because their lifecycle is coupled. Keycloak and PostgreSQL communicate across service boundaries; they do not import Everything's code. Each service owns its image; one Helm chart in `deployment/helm` deploys them all, and adding a service is a values entry (see [adding a service](deployment/documentation/foundation.md#adding-a-service)). Application database migrations belong to Everything. Agents run on the model provider connected through the application; no provider or model is a deployment setting. The planned UI and artifact-serving containers will get their own service folders when implemented; Fleet remains external.

Shared libraries follow the same domain/type structure as services and have specific responsibilities. `@everything/persistence` provides `BaseEntity`, `OwnedEntity`, the `Repository` contract, `OwnerScope`, and an abstract `BaseRepository` with TypeORM-backed lookup/list/delete implementations. `@everything/security` provides the verified `Identity`, `TokenVerifier` contract, Keycloak verification, and a Fastify authentication adapter. `@everything/errors` provides `ApplicationError`. Services consume each library through public package exports and `workspace:*` dependencies. TypeScript packages extend `tsconfig.base.json`; each package's `tsconfig.json` type-checks sources and tests, and `tsconfig.build.json` emits `build/` without tests. See [repository conventions](AGENTS.md) for the rules.

Use Node 24.11+ and pnpm 10.34.6 (`corepack enable`, then `corepack prepare pnpm@10.34.6 --activate`). The devcontainer configures these on creation.

```sh
pnpm install --frozen-lockfile
pnpm build           # Compile code, type-check tests, lint and render the Helm chart, check scripts
pnpm test            # All workspace unit tests
pnpm build:images    # Build all three container images
pnpm cluster:up      # Build, load, and deploy the local stack
pnpm cluster:forward # Serve the stack at http://localhost:8080 through the ingress
pnpm cluster:down    # Delete the local stack and all of its data (asks first; --yes skips)
pnpm test:api        # Bruno API collection against the local stack
pnpm test:restart    # Bruno checks before and after replacing every pod
pnpm test:all        # Build + checks + unit tests + Bruno + pod-replacement verification
```

The Bruno commands require the deployed Minikube stack; they use a running `cluster:forward`, or forward the ingress themselves. `test:restart` and `test:all` restart the three application pods. To work on one service, use `pnpm --filter @everything/everything... build` (or `test`, `start`, `build:image`).

See the [setup and review guide](deployment/documentation/foundation.md) for deploying to a cluster, security configuration, API endpoints, persistence, and Bruno instructions.
