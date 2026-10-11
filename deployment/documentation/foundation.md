# Pi and Keycloak foundation

This slice runs Everything's API and real Pi SDK together, with Keycloak and PostgreSQL in separate Kubernetes pods behind one ingress. Agents run on whichever model provider is connected through the application; no provider or model is part of the deployment. The separate UI pod serves the React/Tailwind PWA; Fleet, chat UI, and the agentic loop remain outside this frontend slice.

## Run it

Requirements: Node 24.11+, pnpm 10.34.6, Docker, kubectl, Helm, and Minikube with an ingress controller. The devcontainer provides all of them: it enables the pinned pnpm version through Corepack, starts Minikube, and installs Traefik as the default ingress controller (`.devcontainer/install-traefik.sh`). The deployment scripts only target the `minikube` context.

```sh
pnpm install --frozen-lockfile
pnpm build
pnpm test
pnpm cluster:up
pnpm test:api          # Bruno API collection; forwards the ingress itself if needed
pnpm cluster:forward   # Serve the stack at http://localhost:8080 for a browser or the Bruno app
```

The application's origin is `http://localhost:8080`: `cluster:forward` forwards the ingress controller there, on loopback only. The ingress routes `/` to the UI, `/v1` and `/health` to the API, and `/auth` to Keycloak, whose admin console is `/auth/admin`. `/health/live` and `/health/ready` are the only unauthenticated API routes.

`cluster:up` builds the UI, Everything, optimized Keycloak, and configured PostgreSQL images, imports them into Minikube, and installs or upgrades the `everything` Helm release from `deployment/helm` with `values.dev.yaml` layered over `values.yaml`. Because the fixed development tags leave pod specs unchanged, it then restarts the Deployments in `rolloutWave` order. Existing databases and volumes are reused, and uninstalling the release keeps every persistent volume claim. `pnpm cluster:down` deletes the stack for a clean start: it uninstalls the release and deletes the namespace, including the database, Keycloak data, agent files, and Pi state. It asks for confirmation unless given `--yes`. Keycloak's startup realm import does not overwrite an existing realm; later realm changes require an explicit migration or an admin-console change.

## Deploy to a cluster

The same chart deploys to any Kubernetes cluster with an ingress controller. `deployment/helm/values.prod.yaml` overrides the development defaults: the image registry and tag, the pull policy, the public origin, and the ingress host. Replace its example values and push the images to that registry as `<registry>/<image>:<tag>`. The chart creates every Secret and the Keycloak realm itself; pass the passwords in a credentials values file kept out of Git, setting each key under `secrets` in `values.yaml`. A missing value fails the render and names the key. Create the release namespace beforehand with the labels in `deployment/cluster/namespace.yaml`; it carries the restricted pod-security policy, so it is not part of the release.

```sh
helm upgrade everything deployment/helm --install --namespace everything \
  --values deployment/helm/values.prod.yaml --values <credentials file>
```

The Ingress uses the cluster's default class unless `global.ingress.className` names one. TLS terminates at the cluster's ingress: configure the certificate there, for example through `global.ingress.annotations` for a certificate issuer. Services communicate over plain HTTP inside the cluster. `global.storageClassName` selects storage for every volume that does not name its own class.

## Authentication and secrets

TLS is the cluster's responsibility. The ingress terminates it, Keycloak trusts the forwarded scheme and host (`KC_PROXY_HEADERS=xforwarded`), and in-cluster traffic, including the API's signing-key requests to Keycloak and both services' database connections, uses plain HTTP or PostgreSQL connections. PostgreSQL requires password authentication for every network connection.

The chart renders every credential into a Secret it owns (`database-credentials`, `keycloak-credentials`, and the `keycloak-realm` import), and containers read them as environment variables from those Secrets. The values come from a values file passed at install time. Development uses the committed `deployment/helm/values.dev.yaml`, whose fixed passwords are for a stack reachable only on the developer's machine: Keycloak's admin console login is `admin` / `admin`, and the seeded user is `owner` / `owner`. Every other environment passes its own credentials file, kept out of Git. Changing a database password after the first deployment does not rotate it inside PostgreSQL; run `pnpm cluster:down` to start over.

The chart renders the realm from `deployment/helm/files/keycloak/`. The production realm, `everything-realm.json`, contains no users and no test clients, and Keycloak fills in its `${EVERYTHING_WEB_CLIENT_SECRET}` placeholder from its environment. It disables self-registration and implicit flow and requires HTTPS for public requests (`sslRequired: all`), which the ingress provides. The confidential `everything-web` client allows the API’s password exchange; browser-facing redirect flows are disabled. See [browser sessions](#browser-sessions) for transport policy and limitations. Create the single user in the admin console with the temporary bootstrap admin `admin`, then replace that admin with a permanent account.

Development seeds the realm: with `keycloakRealm.developmentSeed.enabled`, the chart merges `everything-realm.dev.json` over the production realm, filling in the passwords and client secrets from `values.dev.yaml`, the only file that enables it. The seed allows plain HTTP from local addresses (`sslRequired: external`), adds the user `owner`, and adds three confidential clients for verification: `everything-bruno`, `everything-outsider`, and `wrong-audience`. Their service-account tokens exercise the real Keycloak trust boundary without automating a person's password; they never ship in the production realm.

Every protected `/v1` request verifies an RS256 signature, issuer, audience, subject, timestamps, and Keycloak access-token type. Missing, invalid, expired, wrong-audience, and ID tokens are rejected. Session creation/restoration/logout are the explicitly public `/v1/session` routes. Agent access is scoped to the verified subject, including reads, message sends, interruption, and deletion; unknown and foreign agent IDs both return 404. No application role hierarchy is introduced.

The namespace enforces Kubernetes' restricted pod-security policy. Containers run without root, privilege escalation, Kubernetes API credentials, or writable image filesystems. The current Minikube CNI does not enforce NetworkPolicy, so this slice does not claim network isolation between cluster pods.

## Code boundaries for review

The [repository map](../../README.md) follows deployment boundaries first. `services/ui` owns the frontend and its stateless static server, `services/everything` owns the API and Pi runtime, `services/keycloak` owns authentication configuration, and `services/postgres` owns database initialization and access configuration. Every service has its own `package.json` and `container/Dockerfile`. One Helm chart in `deployment/helm` deploys them all: generic templates render every entry under `services` in `values.yaml`, merged over `serviceDefaults`. Values shared by services live under `global` and are referenced from env values as templates. Images are `<registry>/<image>:<tag>`, combining the global registry and tag with each service's image name. Services list the path prefixes the single Ingress routes to them; `sharedVolumes` declares volumes that several services mount, such as artifacts one service writes and another serves.

### Adding a service

1. Create `services/<name>/` with a `package.json` whose `build:image` script builds `<image>:foundation`, and a `container/Dockerfile`.
2. Add an entry under `services` in `deployment/helm/values.yaml` with its image name, env, ports, probes, resources, volumes, and any `ingress` paths, and a `rolloutWave` after the services it needs at startup. Set `workload: StatefulSet` if it must never run as two copies, such as a database or a process holding in-memory state.

The entry inherits the restricted security contexts and one replica. The chart renders its Deployment or StatefulSet, kept persistent volume claims, a Service for ports with a `servicePort`, and its Ingress paths; `values.schema.json` rejects misspelled or malformed settings, and `deployment/helm/ci/` holds example values that `pnpm build` renders. `pnpm cluster:up` derives the images to load and the restart order from the rendered chart (`deployment/script/stack-chart.sh`), so no script changes are needed.

Shared code is divided into focused workspaces, each following `src/<domain>/<type>/<file>`:

| Library | Responsibility and public exports |
| --- | --- |
| `lib/persistence` | `@everything/persistence/entity` supplies `BaseEntity` and `OwnedEntity`; `/repository` supplies the `Repository` interface, `OwnerScope`, and abstract `BaseRepository`. The base class implements scoped `getById`, `list`, and `delete` through TypeORM. `/schema` provides shared entity column mappings; `/transaction` provides serializable transactions with bounded conflict retries. EntitySchemas and migrations belong to the service. |
| `lib/security` | `@everything/security/identity` supplies the verified caller representation; `/token-verifier` supplies its authentication interface; `/keycloak` creates the JOSE verifier; `/fastify` supplies `requireAuthentication` and the `subject` accessor; `/browser` supplies same-origin cookie sessions; `/password-grant` supplies confidential Keycloak exchanges; `/session-cipher` supplies JOSE authenticated encryption. |
| `lib/agent-contracts` | Browser-safe agent representations, creation inputs, and field limits shared by the API and UI, without importing persistence or service code. |
| `lib/ui` | React controls, accessible dialogs, brand artwork, and semantic tokens for all six themes. Public subpaths separate these responsibilities. |
| `lib/errors` | `@everything/errors` supplies `ApplicationError`, with a safe public message, stable code, and HTTP status. Domain error codes and response handling stay in the service. |

Each service declares only the libraries it consumes. Libraries never depend on service code. Security owns its JOSE dependency; persistence provides the TypeORM base implementation while use cases depend on repository interfaces. The Fastify adapter is a separate security export with an optional Fastify peer dependency, so identity and token verification can also be consumed by other transports.

Everything's composition root calls `createKeycloakTokenVerifier({ issuer, audience, jwksUrl })` using its service configuration. Its protected HTTP scope calls `requireAuthentication(scope, verifier, sessionTokenResolver)`, which decorates the request identity and registers the fail-closed authentication hook in one step. Controllers use the shared `subject(request)` accessor. Future API services use the same identity, verification policy, and authentication failure response while supplying their own trust settings. Resource ownership and any future domain authorization remain service responsibilities. Keycloak owns user records. The API resolves cookie sessions and refreshes their server-held tokens; its authentication hook verifies tokens from either a session or an explicit bearer header. Explicit Authorization never falls back to a cookie.

Within Everything, code follows `services/everything/src/<domain>/<type>/<file>`. The paths below are relative to that source root. PostgreSQL owns database provisioning; the Everything service owns its application schema. No service imports another service's source code. Cross-service checks live in the separate `@everything/api-tests` workspace.

| Boundary | Responsibility |
| --- | --- |
| `agent/controller` | Expose agent definition operations; deletion goes through `AgentRemoval` so the runtime stops first. |
| `agent/service`, `agent/interface` | Agent use cases and contracts independent of PostgreSQL. |
| `agent/repository` | Mapped TypeORM operations for owner-scoped agent definitions. |
| `agent/schema`, `conversation/schema` | TypeORM EntitySchemas and TypeBox request schemas; length limits come from domain model constants. |
| `<domain>/error` | Each domain's `ApplicationError` subclasses, so every public error code is defined once. |
| `conversation/controller`, `conversation/service` | Visible chat, runtime status, interruption, and orderly deletion (`AgentRemoval`). |
| `conversation/interface`, `conversation/repository` | Visible-message persistence boundary and PostgreSQL adapter. |
| `runtime/interface`, `runtime/service` | Runtime contract and `AgentRuntime`, which owns one agent's turn and public status. |
| `runtime/adapter`, `runtime/tool`, `runtime/prompt` | The Pi SDK implementation, the `send_message` tool, and the main-agent prompt. |
| `workspace/interface`, `workspace/service` | Each agent's working directory on the shared agents volume, removed when the agent is deleted. |
| `session/controller`, `session/service`, `session/repository` | Same-origin login/logout, server-side refresh and revocation, capability-scoped encrypted persistence. |
| `health/controller`, `identity/controller` | Unauthenticated probes and `/v1/me`. |
| `http/` | Shared request-schema helpers, strict validation options, and public error mapping. |
| `application/bootstrap`, `application/factory` | The composition root (constructs adapters, injects dependencies, owns shutdown) and HTTP composition. |

`BaseRepository<TEntity, TScope, TRecord>` receives a TypeORM repository and typed listing options. Concrete repositories implement `scopeWhere` using mapped properties and relations, and `toEntity` to exclude persistence-only fields. Lookups and listings use TypeORM find operations; deletion verifies ownership and removes the record in a serializable transaction. Empty scopes and missing identifiers fail closed. The data source explicitly rejects null or undefined ORM predicates.

Agents inherit the base operations with an owner filter. Messages filter by both agent ID and the related agent's owner; their listing calls `super.list(scope)` for the newest 100 and reverses the result into chronological order. Message insertion locks the owned parent while persisting its child. `p-retry` retries only rolled-back serialization/deadlock conflicts, up to four retries; connection ambiguity and application errors are never replayed. Transaction callbacks contain database work only.

TypeORM `EntitySchema` definitions live beside their domains. Shared base columns keep IDs and ISO timestamp mapping consistent. Internal message relations and sequence values are excluded from public responses. Application services continue to depend on interfaces.

The other infrastructure replacements are `env-schema` for typed, validated environment settings and `async-lock` for per-agent asynchronous coordination. Agent lifecycle behavior remains a domain rule. Fastify/TypeBox already handle HTTP validation, Helmet and rate-limit handle transport protections, JOSE handles JWT cryptography, and Pi owns model streaming and session persistence.

Transport and use cases depend on interfaces. Pi and PostgreSQL can be replaced without changing the controllers or conversation coordinator.

## API

Requests and assertions are executable in [the Bruno collection](../../testing/api/bruno/bruno.json). Open `testing/api/bruno` in Bruno, select `Local`, and run the `requests` folder while `cluster:forward` is running. Requests are grouped by what they verify, and the folders run in order:

| Folder | Verifies |
| --- | --- |
| `01-health` | Liveness and database readiness, without authentication. |
| `02-authentication` | Missing, invalid, and wrong-audience tokens are rejected; obtains the test identities' tokens for the folders after it. |
| `03-agents` | Definition validation, creation, listing, reading, profile edits, avatar selection, and deletion. |
| `04-agent-capacity` | Several agents exist at once; the number is not limited by storage. |
| `05-conversation` | Message validation, an empty conversation, the unloaded runtime, and interrupting an idle agent. |
| `06-ownership` | Another identity cannot read, edit, message, or delete a teammate. |

After authentication, each folder creates the agents it needs and deletes them at its end, so a folder can be run on its own once `02-authentication` has run. `restart/before` and `restart/after` hold the restart phases that `pnpm test:restart` runs around replacing the pods. The `Local` environment holds the development test clients' secrets from `values.dev.yaml`. `pnpm test:api` invokes `bru run` directly with the same collection; there is no custom runner or HTTP client.

| Method | Path | Result |
| --- | --- | --- |
| GET | `/health/live` | Process liveness. |
| GET | `/health/ready` | Database readiness. |
| GET | `/v1/me` | Verified subject. |
| GET | `/v1/agents` | Caller-owned agent definitions. |
| POST | `/v1/agents` | Create `{ "name": "Chosen by the user", "systemPrompt": "...", "avatarId": "avatar-01" }`. Avatar selection is optional. |
| GET | `/v1/agents/:agentId` | Read a definition. |
| PATCH | `/v1/agents/:agentId` | Edit any supplied `name`, `systemPrompt`, or `avatarId` field; omitted fields keep their saved values. |
| DELETE | `/v1/agents/:agentId` | Stop execution, delete the agent's files, and remove application records. |
| GET | `/v1/agents/:agentId/messages` | Latest 100 visible messages, chronologically ordered. |
| POST | `/v1/agents/:agentId/messages` | Persist `{ "text": "..." }`, interrupt prior work, and return 202 with message/run IDs. |
| GET | `/v1/agents/:agentId/runtime` | `idle`, `running`, or `error`, plus the loaded session ID. |
| POST | `/v1/agents/:agentId/interrupt` | Abort generation and await in-flight tools. |

Request schemas reject unexpected properties, invalid IDs, empty messages, and excessive input. Bodies are bounded to 64 KiB. Rate limits and security headers are applied; authorization headers are redacted from logs. Public runtime errors do not contain provider responses or credentials.

Profile edits require at least one field and accept only the 64 built-in avatar IDs (`avatar-01` through `avatar-64`). The shared `@everything/agent-contracts` package defines the inputs and public response; its `/avatar` export defines stable IDs independently of artwork or animation states. Every definition response includes `avatarId`; creation without a selection defaults to `avatar-01`. The profile service depends on `AgentProfileStore`, and the PostgreSQL update includes the verified owner in its predicate. Missing and inaccessible IDs both return the same 404 response. Existing name-only PATCH requests remain valid.

## Persistence and execution

PostgreSQL has its own PVC and separate database roles/databases for Keycloak and Everything. Everything stores user-named agent definitions and visible conversation messages there. Pi's native JSONL history remains on disk. TypeORM owns database connections and runs tracked migrations through `everything_migrations`. Schema synchronization and automatic dropping are disabled. The initial migration creates the constrained schema; later schema changes add new migrations.

The avatar migration adds the constrained, non-null `agents.avatar_id` column and backfills existing definitions with `avatar-01`. The UI's Description field edits the existing `systemPrompt`; it does not introduce separate descriptive metadata. Saving a profile never starts or interrupts execution. A loaded Pi session retains its prompt snapshot until it is unloaded and reopened; newly loaded sessions use the saved instructions. Live prompt changes belong to the future conversation workflow.

Agents are created at runtime and are not limited in number, so their files share one volume (`everything-agents`, mounted at `/agents`), each agent in a directory named by its ID. A volume per agent, as the architecture page describes, would require redeploying the pod for every new agent, because a running pod cannot gain volume mounts. A second volume (`everything-state`) stores shared Pi provider configuration, credentials, and catalog state. The Everything container requests 3 GiB of memory with a 4 GiB limit, since every active agent's session runs in it; PostgreSQL requests 512 MiB with a 1 GiB limit.

Agents do not store a provider or model. When a session opens, Pi resumes the session's previous model if its provider still has credentials, and otherwise uses the connected provider's default model. Until a provider is connected, sending a message returns 503 `PROVIDER_UNAVAILABLE` and saves nothing. The application does not yet offer a way to connect one: the UI explains its unavailable state. A future provider connection will store credentials in Pi's state on the shared PVC.

Each agent has one conversation in this slice. Its Pi session is reopened lazily on the next message after a restart. Runtime status is process-local and initially reports an unloaded `sessionId`; saved conversations and native context survive. User input aborts the current Pi turn, waits for it to settle, then starts the new turn. Different agents can run concurrently; same-agent operations are serialized. Everything runs as a single-replica StatefulSet, as does PostgreSQL: Kubernetes never starts a replacement pod until the previous one is confirmed gone, so two processes never run the same agents or open the same data directory, even when a node stops responding. The cost is that a pod on a failed node stays down until the node is removed or the pod is force-deleted. Keycloak keeps its state in PostgreSQL and runs as a Deployment.

Only `send_message` is enabled as an agent tool for this first slice. Pi's ordinary assistant output is private, even when it contains text. General shell/file execution and Fleet delegation are not enabled. Deleting an agent stops its runtime, deletes its directory with its files and JSONL transcripts, then removes its definition and messages; if a step fails, deleting again completes it.

Already saved state must survive restart. An in-flight turn can be interrupted or lost, and is not replayed automatically. PVCs protect against pod replacement, not volume deletion or loss of the cluster.

## Validation

```sh
pnpm test
pnpm test:api
# Restarts all application pods; uses a running cluster:forward or forwards the ingress itself.
pnpm test:restart
pnpm format:check
pnpm audit
```

From the repository root, `pnpm build` compiles shared libraries before the Everything service, lints and renders the Helm chart with the development, production, and `ci/` values, and checks the deployment scripts' syntax. `pnpm build:images` builds each container through its owning workspace. For a single combined validation run after `pnpm cluster:up`, run `pnpm test:all`: this runs the build, unit tests, Bruno, and restart verification, using a running `cluster:forward` or forwarding the ingress itself.

The persistence library tests scope/identifier guards and transaction retry boundaries. The security library owns unit tests for token trust, endpoint validation, and request authentication. The Everything service tests configuration validation, request validation and error mapping, agent ownership, runtime turn state, agent directory removal, and concurrency/lifecycle behavior. Every package's `check` script type-checks its tests as part of `pnpm build`. Bruno exercises the deployed API with real Keycloak tokens: authentication, validation, ownership isolation, runtime status, deletion, and creating more agents than any fixed capacity would allow. Its requests pass whether or not a provider is connected. Model turns need a connected provider, so they are not automated; unit tests cover interruption, failure reporting, and the provider check with test doubles. `deployment/script/verify-restart.sh` runs the collection's `restart/before` requests, replaces every chart workload (including the UI), then runs `restart/after`. All authentication, API requests, and assertions are native Bruno requests. A temporary Bruno environment under `.local` carries the agent ID and subject between phases and is removed afterward. The shell script only coordinates Bruno, Kubernetes, and its own port forward to the ingress. Use `pnpm test:restart` for this sequence; running both folders back-to-back in the GUI would not restart pods. Successful tests remove their test agents. A failed Bruno or restart run may leave its test agent for inspection.

A single `pnpm-lock.yaml` pins the whole workspace dependency graph. Each service declares its own dependencies; the root package contains only workspace tooling. The API Docker build uses a filtered install and `pnpm deploy --prod` to package only that service and its runtime dependencies. Narrow overrides update vulnerable dependencies used by Bruno's development tooling; the API image omits that tooling. Rerun the collection when updating these overrides.

Verified in the local Minikube environment through the Traefik ingress: 64 unit tests, 37 API checks, and 10 desktop/phone browser checks passed. A real browser session survived replacement of the UI and API pods, refreshed its Keycloak tokens, served concurrent authenticated requests, and rejected cookie replay after logout. Browser checks cover inline invalid-credential feedback, no navigation or requests to Keycloak, HttpOnly cookies, reload/deep-link restoration, agent creation/renaming, themes, and offline behavior.

Implementation references: [Pi SDK](https://github.com/badlogic/pi-mono/blob/main/packages/coding-agent/docs/sdk.md), [Keycloak containers](https://www.keycloak.org/server/containers), [Keycloak OIDC](https://www.keycloak.org/securing-apps/oidc-layers), and [Bruno CLI](https://docs.usebruno.com/bru-cli/run/options).

ORM and infrastructure references: [TypeORM entity schemas](https://typeorm.io/docs/entity/separating-entity-definition/), [TypeORM migrations](https://typeorm.io/docs/migrations/setup/), [env-schema](https://github.com/fastify/env-schema), and [async-lock](https://github.com/rogierschouten/async-lock).

## Browser sessions

The welcome page submits a username and password to `POST /v1/session` on the same origin. Everything exchanges them with Keycloak over its internal HTTP endpoint using the dedicated confidential `everything-web` client. The API forwards the configured public scheme and host to Keycloak, matching the chart's `xforwarded` proxy settings and production HTTPS policy. The UI never navigates to Keycloak or receives its access/refresh tokens. `GET /v1/session` returns only the display profile; `POST /v1/session/logout` deletes the session and clears its cookie. Existing bearer API clients continue to work.

The cookie is host-only, HttpOnly, SameSite=Strict, and Secure with a `__Host-` prefix on HTTPS. Local HTTP uses an unprefixed development cookie. Login, logout, and cookie-authenticated mutations require the exact configured `PUBLIC_ORIGIN`; requests with explicit bearer authorization remain independent of cookie policy. Login attempts are limited to 20 per minute per client IP, with Keycloak's account-level brute-force protection also enabled. Credentials and cookies are redacted from request logs, and session responses use `Cache-Control: no-store`.

The `browser_sessions` table stores a hash of the random 256-bit cookie capability and JOSE A256GCM-encrypted Keycloak grants. Passwords are never persisted. Sessions expire after at most eight hours, or sooner at Keycloak's refresh expiry. Refreshes serialize per session in the existing single API replica; no browser tab can race another refresh. Each refresh still verifies issuer, signature, audience, and subject. Logout invalidates the stored capability before best-effort Keycloak revocation, so local logout still works during a provider outage. Expired records are removed when presented and the authenticated owner's expired records are pruned on successful sign-in. A database copy alone cannot decrypt the grants; keep the encryption key separate from database backups. Rotating that key signs out existing browser sessions.

The Helm chart requires `secrets.browser-auth.client-secret` and `secrets.browser-auth.session-encryption-key`. Supply a high-entropy client secret and a base64-encoded 32-byte encryption key in the external credentials values file. Generate each with `openssl rand -base64 32`. Only `values.dev.yaml` contains fixed public development values. The API receives both secrets; Keycloak receives the client secret for realm import; the frontend receives neither. The tracked migration runs at API startup. A stable encryption key and PostgreSQL volume preserve sessions through pod replacements.

Keycloak's startup import does not update an existing realm. For an existing installation, create or update `everything-web` through Keycloak's admin API using the client definition in `deployment/helm/files/keycloak/everything-realm.json`, with `secret` set to the same externally supplied chart value. Use client-secret authentication, Direct Access Grants enabled, standard/implicit/service-account flows disabled, no redirects or web origins, and the existing `everything-api` audience mapper. Disable the superseded `everything-ui` public client after the new UI is deployed. Do not delete the realm or its users. New installations import the correct client automatically.

This is a password-only login flow as requested. Keycloak calls it **Direct Access Grants**. It does not support browser authentication steps such as passkeys, federated redirects, required actions, or interactive MFA; accounts requiring these steps cannot complete this form. OAuth's current security guidance discourages this grant; adding those capabilities requires revisiting the authentication flow. See [Keycloak's grant documentation](https://www.keycloak.org/securing-apps/oidc-layers) and [OAuth Security Best Current Practice, section 2.4](https://www.rfc-editor.org/rfc/rfc9700.html#section-2.4).
