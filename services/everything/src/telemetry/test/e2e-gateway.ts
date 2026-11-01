import assert from "node:assert/strict";
import type { TestContext } from "node:test";
import { ApiDocumentationService } from "../../api-documentation/service/api-documentation-service.js";
import {
  createHttpApplication,
  type HttpDependencies,
} from "../../application/factory/http-application.js";
import { loadTelemetrySettings } from "../config/telemetry-config.js";
import { createTelemetryReader } from "../factory/telemetry-reader.js";
import { activeTelemetry } from "../factory/telemetry-runtime.js";
import { telemetryEvents } from "../model/telemetry-attributes.js";
import { failure, settled, teammate } from "./runtime-fixtures.js";

/**
 * A local gateway for the Telemetry page's browser test against a real OpenObserve: the production
 * HTTP application with the real telemetry reader, owner A signed in by a fixed test session cookie,
 * and one real teammate turn per owner that fails at a fake provider, so OpenObserve holds the
 * failures the page shows. deployment/script/test-telemetry.sh --browser starts it with the
 * instrumentation preload, which exports to the same OpenObserve:
 *
 *   TELEMETRY_URL=… TELEMETRY_PASSWORD_FILE=… TELEMETRY_STREAM=… \
 *     node --import tsx --import ./src/telemetry/bootstrap/instrumentation.ts src/telemetry/test/e2e-gateway.ts
 */
const port = Number(process.env.TELEMETRY_E2E_GATEWAY_PORT ?? 18_182);
const origin = process.env.TELEMETRY_E2E_ORIGIN ?? "http://localhost:5182";

/** Every operation the Telemetry page does not use fails loudly. */
function unused<T>(): T {
  return new Proxy(
    {},
    {
      get: (_target, property) => () =>
        assert.fail(`Unused: ${String(property)}`),
    },
  ) as T;
}

const telemetry = activeTelemetry();
if (!telemetry)
  throw new Error(
    "Start the gateway with the instrumentation preload and TELEMETRY_URL",
  );
const settings = loadTelemetrySettings(process.env);
const reader = createTelemetryReader(settings);

// Real turns through Everything's runtime, each failing at a fake provider.
const cleanups: (() => unknown)[] = [];
const context = {
  after: (cleanup: () => unknown) => cleanups.push(cleanup),
} as unknown as TestContext;
const ownerA = await teammate(
  context,
  () =>
    failure(
      429,
      {
        error: {
          message: "Rate limit reached for requests per minute",
          type: "rate_limit_exceeded",
        },
      },
      { "x-request-id": "req_browser_e2e_429", "retry-after": "20" },
    ),
  "owner-a",
);
const ownerB = await teammate(
  context,
  () =>
    failure(500, {
      error: {
        message: "Owner B's private provider failure",
        type: "server_error",
      },
    }),
  "owner-b",
);
// Owner A's message holds a synthetic key, which the page must show only redacted.
ownerA.runtime.start(
  "Plan the launch; the staging key is sk-proj-e2ebrowsercanaryabcdefgh",
);
ownerB.runtime.start("Plan the launch");
await Promise.all([settled(ownerA.runtime), settled(ownerB.runtime)]);
await telemetry.flush();
/** An owner's model failure once OpenObserve has made it searchable. */
async function searchable(ownerId: string) {
  const deadline = Date.now() + 60_000;
  for (;;) {
    const page = await reader
      .events(ownerId, { severity: "error" })
      .catch(() => undefined);
    const found = page?.records.find(
      (record) => record.name === telemetryEvents.modelFailed,
    );
    if (found) return found;
    if (Date.now() > deadline)
      throw new Error("OpenObserve did not make the failure searchable");
    await new Promise((resolve) => setTimeout(resolve, 500));
  }
}
await searchable("owner-a");
const otherTrace = (await searchable("owner-b")).traceId;

const dependencies: HttpDependencies = {
  apiDocumentation: new ApiDocumentationService(),
  verifier: {
    verify: async (token) => {
      if (token !== "telemetry-e2e-token") throw new Error("invalid");
      return { subject: "owner-a" };
    },
  },
  sessions: {
    ...unused<HttpDependencies["sessions"]>(),
    resolve: async (handle) =>
      handle === "telemetry-e2e-session"
        ? {
            accessToken: "telemetry-e2e-token",
            profile: { subject: "owner-a", displayName: "Owner A" },
          }
        : undefined,
  },
  publicOrigin: origin,
  chatGptRedirectUri: "http://127.0.0.1:8080/v1/providers/chatgpt/callback",
  keys: unused(),
  credentialGrants: unused(),
  credentialRollouts: unused(),
  providers: unused(),
  models: unused(),
  agents: unused(),
  agentActivity: unused(),
  profiles: unused(),
  removal: unused(),
  conversations: unused(),
  attachments: unused(),
  subagents: unused(),
  updates: unused(),
  upgrades: unused(),
  artifacts: unused(),
  workers: unused(),
  generalSettings: unused(),
  teammateOrder: unused(),
  workspaces: unused(),
  workspaceActivity: unused(),
  voice: unused(),
  voiceStreams: unused(),
  telemetry: reader,
  readiness: async () => {},
};
const app = await createHttpApplication(dependencies);
await app.listen({ port, host: "127.0.0.1" });
// Owner B's trace is printed only so the browser test can show owner A cannot open it.
console.log(
  `ready ${port} agent ${ownerA.definition.id} other-trace ${otherTrace}`,
);
process.once(
  "SIGTERM",
  () =>
    void (async () => {
      await app.close();
      for (const cleanup of cleanups.reverse()) await cleanup();
      await telemetry.shutdown();
      process.exit(0);
    })(),
);
