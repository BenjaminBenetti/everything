import assert from "node:assert/strict";
import { test } from "node:test";
import type { ArtifactHostDependencies } from "../../viewing/controller/artifact-host-controller.js";
import { ViewCookie } from "../../viewing/handler/view-cookie.js";
import { ViewPassCredentials } from "../../viewing/handler/view-pass-credentials.js";
import { createPublicApplication } from "../factory/public-application.js";

test("the artifact host never writes API keys or query strings to its logs", async (context) => {
  const key = `everything_app_key_${"s".repeat(43)}`;
  const written: string[] = [];
  const write = process.stdout.write.bind(process.stdout);
  process.stdout.write = ((chunk: string | Uint8Array) => {
    written.push(String(chunk));
    return true;
  }) as typeof process.stdout.write;
  context.after(() => {
    process.stdout.write = write;
  });
  const host = await createPublicApplication({
    access: { viewer: async () => undefined },
    cookie: new ViewCookie("http://localhost:8081"),
    passes: { find: async () => undefined },
    passCredentials: new ViewPassCredentials(),
    apiKeys: { authenticate: async () => undefined },
    artifacts: { findBySlug: async () => undefined },
    publicOrigin: "http://localhost:8080",
  } as unknown as ArtifactHostDependencies);
  const response = await host.inject({
    url: `/hooks/webhook?api_key=${key}`,
    headers: { "x-api-key": key },
  });
  await host.close();
  process.stdout.write = write;
  assert.equal(response.statusCode, 401);
  const logs = written.join("");
  assert.match(logs, /\/hooks\/webhook/);
  assert.doesNotMatch(logs, /everything_app_key_|api_key/);
});
