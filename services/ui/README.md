# Everything UI

React and Tailwind, served by a stateless Fastify pod. `deployment/helm/values.yaml` adds the `ui` Deployment, Service, probes, resources, and `/` ingress route through the existing generic chart. `/auth`, `/v1`, and `/health` continue to route to their owning services. The UI runs as UID 1000 with a read-only root filesystem and needs no volume or secret.

## Run and verify

From the repository root:

```sh
pnpm install --frozen-lockfile
pnpm build
pnpm test
pnpm cluster:up
pnpm cluster:forward
# Open http://localhost:8080; local development sign-in is owner / owner.

pnpm --filter @everything/ui-tests exec playwright install chromium
pnpm test:ui
```

The browser suite uses the actual ingress and Keycloak, covers desktop and phone layouts, creates and cleans up its own teammates, and verifies persistence, failures, modal focus, themes, and sign-out. Deterministic chat tests replace API responses to exercise sending, compaction progress, stopping, pagination, navigation, and reload without paid inference. The live conversation check sends two short messages through an active provider and verifies recall after reload; it skips when no provider is connected. Override `UI_TEST_ORIGIN`, `UI_TEST_USERNAME`, and `UI_TEST_PASSWORD` for another test installation. `PLAYWRIGHT_CHROMIUM_EXECUTABLE` can select an existing Chromium executable. Browser traces are disabled because sign-in requests contain passwords; screenshots and results go to `.local/ui-test-results`.

To serve the built UI independently, run `PORT=8081 pnpm --filter @everything/ui-service start`. The host needs only `PORT` and the same image works across environments. Use the ingress origin for functional authentication: the API validates cookie mutations against `global.publicOrigin`.

For hot reload, keep `cluster:forward` running and run `pnpm --filter @everything/ui-service dev`. Vite proxies `/v1` to the local ingress. Set the API's `PUBLIC_ORIGIN` to `http://localhost:5173` for that development session and restore it to the ingress origin afterward. The Keycloak issuer stays at the configured ingress origin. Do not widen production origin checks for Vite.

## Implemented surfaces

- Welcome screen with the mockup’s username/password form, inline errors, pending state, constellation brand, and static grid artwork. Sign-in and sign-out stay on the application page; reloads and deep links restore the server session. Password managers use standard autocomplete attributes.
- Home, team, updates, and apps pages following the checked-in concept. Create teammates, inspect their profiles, search, and edit their names, descriptions, and avatars through the API. Editing preloads all saved fields and preserves the draft on failures. Details place Delete on the left, away from Edit; a shared confirmation dialog names the teammate and initially focuses Cancel. Confirmed deletion removes the teammate from every team listing, with pending protection and retry feedback.
- The Apps page at `/apps` lists every shared app with its kind, status, and who changed it last. Search matches titles, slugs, and descriptions. Running apps and live pages come first, then starting, failing, stopped, and unpublished apps; each group is newest-updated first. Clicking a live card opens a new tab through `/apps/open`, which asks the API for a one-time link and continues to the app on its separate host. Pause/play stops or resumes the saved release, including static pages; stopped and unpublished apps offer confirmed deletion. Controls disable during requests or a failed status refresh. The list refreshes every five seconds.
- A searchable catalog of 64 static pixel-art avatars, grouped into animals, creatures, and objects. The reusable teammate avatar renders the saved selection in cards, details, the editor, and the sidebar. Selecting artwork is part of the profile draft; it persists when the profile is saved. Animation is deferred, with stable IDs independent of future animation states. See [artwork, prompts, and provenance](documentation/teammate-avatars.md).
- Midnight, Midnight Dimmed, Graphite, Graphite Dimmed, Daylight, and Sand, with one semantic token contract. The signed-in avatar opens Preferences, with custom preview cards shared across desktop and phone. Appearance persists locally; `?theme=sand` and the other theme IDs are supported.
- The topbar's Settings button opens settings that apply to the whole workspace, saved on the server, unlike Preferences, which are saved on the device. Workers has one switch, Privileged workers ("Enables Docker support."), which shows the saved value, is disabled while a change saves, and explains with a retry when workers are not available yet. `@everything/ui/switch` is the shared, theme-aware switch for on/off settings.
- Responsive desktop/sidebar and phone/bottom navigation, keyboard-friendly dialogs, focus restoration, reduced motion, loading, empty, and retry states.
- Installable PWA metadata and Home Screen icons. A service worker caches only a generic offline page, its stylesheet, and its icon. It does not cache authenticated HTML, API responses, or identity-provider traffic.

Every teammate card and sidebar link opens `/team/:agentId`, the teammate's sole ongoing conversation. Messages persist on the server; earlier history is available in pages of 100. Sending uses the saved provider, model, and effort. Enter sends, Shift+Enter adds a line, failed requests retain the draft, and Stop reply cancels active work. Progress polling pauses in background tabs and refreshes on return; it never triggers model requests. Automatic compaction summarizes older model context and preserves the visible history. There is no chat creation, switching, or branching within a teammate. Plain text replies preserve line breaks; rich text and token streaming are deferred.

Updates is an empty surface, without demo content. Phone onboarding does not request notification permissions before a push delivery/subscription service exists.

Model providers opens a compact picker for ChatGPT plan sign-in, Claude API keys, and an OpenAI-compatible base address with an optional key for local servers. Selecting a provider opens its own setup page in the same dialog; Back returns to the list and restores focus to that option. API-key pages show their fields immediately, and ChatGPT callbacks open its sign-in page directly. Each connection is saved independently in encrypted, owner-scoped database records. Save and check sends a short inference request; the icon is green only after a completed check. Verification is fresh for 15 minutes, with a timestamp and an explicit action to check again. Status polling reads metadata and does not generate paid requests. Keys are write-only; editing an API address never reuses a key for a different destination. Advanced settings can specify a model when discovery is unavailable. These controls do not start teammates.

ChatGPT uses the new open-source dynamic-registration flow and public Responses API. Its required loopback return address is separate from the app's public hostname. When the callback reaches the ingress, it returns to the app automatically; when using a remote installation, the dialog accepts the full return address from the sign-in tab. Only temporary OAuth anti-CSRF state is stored in browser session storage. Tokens stay encrypted on the server, refresh before checks, and are removed on disconnect. Failed remote revocation is reported with a link to ChatGPT usage settings.

## Boundaries

Product copy uses “teammate” throughout, with plain, friendly wording and explicit actions. The `agent` domain names and API identifiers remain technical contracts; user-supplied names and instructions are displayed as written.

Each teammate has exactly one ongoing user-facing conversation. Opening a teammate always returns to the same message history, like returning to a text exchange with a person. The UI does not offer new conversations, conversation switching, or branches within a teammate. Internal Pi sessions and background conversations remain implementation details and never appear as separate conversations in the UI.

Source follows `src/<domain>/<type>/<file>`. `application/bootstrap` assembles the concrete adapters; pages consume narrow interfaces through React providers. TanStack Query coordinates the agent directory’s loading and cache; React Router owns navigation; Radix supplies dialog focus/keyboard behavior. The UI never imports another service’s implementation.

- `@everything/agent-contracts`: shared public DTOs and field limits. The API keeps persisted owned entities, validation, authorization, and repository operations.
- `@everything/security/browser`: same-origin session contract and HTTP adapter. Keycloak tokens stay on the server; appearance and temporary OAuth anti-CSRF state use browser storage. The API uses `/password-grant` and `/session-cipher` separately, so no server credential code is bundled into the frontend.
- `@everything/provider-contracts`: public connection metadata, write-only inputs, and shared limits. Provider protocols, verification, and encrypted credentials stay in the API service.
- `@everything/ui`: shared controls, branding, accessible modal surface, and semantic tokens. Layout and feature policy remain in this service.

The profile endpoint is `PATCH /v1/agents/:agentId`, backed by the scoped editing service and mapped TypeORM update. It accepts name, `systemPrompt` (the existing text shown as Description), and `avatarId`, retaining omitted fields. It returns 404 for both missing and inaccessible teammates and never starts a conversation. The tracked avatar migration assigns `avatar-01` to existing definitions; API creation without an explicit avatar retains that fallback. The UI chooses a random avatar once per new draft and saves that selection unless the user changes it. The UI catalog maps the shared IDs to bundled artwork under `public/teammate-avatars`.

Descriptions continue to use the existing instructions field. Saving blank text uses the general-help default shown by the form’s helper text. On the next message, the backend reloads a session whose saved instructions or model settings have changed, retaining its existing context and conversation.

Browser authentication adds `GET /v1/session`, `POST /v1/session`, and `POST /v1/session/logout`, plus a tracked `browser_sessions` migration. The API owns cookie policy, scoped persistence, refresh coordination, and logout. See [session deployment and constraints](../../deployment/documentation/foundation.md#browser-sessions).

The visual reference is the repository’s [UI concept](../../planning/ui-concept/README.md). Infrastructure references: [Keycloak password grants](https://www.keycloak.org/securing-apps/oidc-layers) and [Tailwind’s Vite integration](https://tailwindcss.com/docs/installation/using-vite).

Saved `/artifacts` and `/artifacts/open` links redirect to the matching `/apps` routes, preserving the requested app and page.
