import { readFileSync } from "node:fs";
import assert from "node:assert/strict";
import { AgentNotFoundError } from "../../agent/error/agent-errors.js";
import type { AgentDefinition } from "../../agent/model/agent.js";
import { ApiDocumentationService } from "../../api-documentation/service/api-documentation-service.js";
import {
  createHttpApplication,
  type HttpDependencies,
} from "../../application/factory/http-application.js";
import { createVoiceRuntime } from "../factory/voice-runtime.js";

/**
 * A local gateway for browser end-to-end tests against a real streaming speech service: the
 * production HTTP application with voice streaming enabled, one owner signed in by a fixed test
 * session cookie, and one teammate. Everything else is unavailable. The service URL and the path of
 * its token file come from the environment; the token is read only here and never printed.
 *
 *   VOICE_E2E_STREAM_URL=ws://… VOICE_E2E_TOKEN_FILE=/path VOICE_E2E_ORIGIN=http://localhost:5181 \
 *     node --import tsx src/voice/test/e2e-gateway.ts
 */
export const e2eAgentId = "6f1c1f6e-8c7e-4c4b-9a43-2d8b8f7c8f11";

const port = Number(process.env.VOICE_E2E_PORT ?? 18_181);
const origin = process.env.VOICE_E2E_ORIGIN ?? "http://localhost:5181";
const url = process.env.VOICE_E2E_STREAM_URL;
const tokenFile = process.env.VOICE_E2E_TOKEN_FILE;
if (!url) throw new Error("VOICE_E2E_STREAM_URL is required");

/** Every operation the voice route doesn't use fails loudly. */
function unused<T>(): T {
  return new Proxy(
    {},
    {
      get: (_target, property) => () =>
        assert.fail(`Unused: ${String(property)}`),
    },
  ) as T;
}

const runtime = await createVoiceRuntime(
  {
    service: null,
    stream: {
      url,
      token: tokenFile ? readFileSync(tokenFile, "utf8").trim() : "",
      finalTimeoutMs: 30_000,
      concurrency: 1,
    },
    admission: { concurrency: 1, queueLimit: 0, queueTimeoutMs: 1_000 },
  },
  {
    async get(ownerId, id) {
      if (ownerId !== "e2e-owner" || id !== e2eAgentId)
        throw new AgentNotFoundError();
      return { id } as AgentDefinition;
    },
  },
  () => undefined,
  { verify: async () => false, decode: async () => assert.fail("No uploads") },
);
const dependencies: HttpDependencies = {
  apiDocumentation: new ApiDocumentationService(),
  verifier: {
    verify: async (token) => {
      if (token !== "e2e-token") throw new Error("invalid");
      return { subject: "e2e-owner" };
    },
  },
  sessions: {
    ...unused<HttpDependencies["sessions"]>(),
    resolve: async (handle) =>
      handle === "e2e-session"
        ? {
            accessToken: "e2e-token",
            profile: { subject: "e2e-owner", displayName: "E2E" },
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
  subagents: unused(),
  updates: unused(),
  upgrades: unused(),
  artifacts: unused(),
  workers: unused(),
  generalSettings: unused(),
  teammateOrder: unused(),
  workspaces: unused(),
  workspaceActivity: unused(),
  voice: runtime.uploads,
  voiceStreams: runtime.streams,
  readiness: async () => {},
};
const app = await createHttpApplication(dependencies);
app.addHook("preClose", async () => runtime.close());
await app.listen({ port, host: "127.0.0.1" });
process.once("SIGTERM", () => void app.close().then(() => process.exit(0)));
