import assert from "node:assert/strict";
import { test } from "node:test";
import { mkdtemp, mkdir, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createStaticServer } from "../factory/static-server.js";

test("serves deep links and probes without swallowing API or asset misses", async (context) => {
  const root = await mkdtemp(join(tmpdir(), "everything-ui-"));
  await mkdir(join(root, "assets"));
  await writeFile(
    join(root, "index.html"),
    "<!doctype html><title>Everything</title>",
  );
  await writeFile(
    join(root, "assets", "app-hash.js"),
    "export const app = true;",
  );
  const app = await createStaticServer(root);
  context.after(async () => {
    await app.close();
    await rm(root, { recursive: true, force: true });
  });
  for (const url of [
    "/",
    "/team",
    "/team/06eb92d4-3ee3-4a6a-93d1-1a984d7691cb",
    "/workspaces",
    "/keys",
    "/updates",
    "/apps",
    "/apps/open",
  ]) {
    const response = await app.inject({ url });
    assert.equal(response.statusCode, 200, url);
    assert.match(response.body, /<title>Everything/);
    assert.equal(response.headers["cache-control"], "no-store");
    assert.match(
      String(response.headers["content-security-policy"]),
      /frame-ancestors 'none'/,
    );
    assert.match(
      String(response.headers["content-security-policy"]),
      /img-src 'self' data: https:/,
    );
    // Voice input may use the microphone on the application's own origin, never in an embedded frame.
    assert.equal(response.headers["permissions-policy"], "microphone=(self)");
  }

  for (const [url, destination] of [
    ["/artifacts", "/apps"],
    [
      "/artifacts/open?slug=trip-planner&path=%2Fdays%3Fday%3D2",
      "/apps/open?slug=trip-planner&path=%2Fdays%3Fday%3D2",
    ],
  ]) {
    const response = await app.inject({ url: url! });
    assert.equal(response.statusCode, 308);
    assert.equal(response.headers.location, destination);
    assert.equal(response.headers["cache-control"], "no-store");
  }

  assert.equal((await app.inject({ url: "/ui-health" })).statusCode, 200);
  const asset = await app.inject({ url: "/assets/app-hash.js" });
  assert.equal(
    asset.headers["cache-control"],
    "public, max-age=31536000, immutable",
  );
  for (const url of [
    "/assets/missing.js",
    "/v1/agents",
    "/auth",
    "/config.json",
    "/callback",
    "/unknown",
    "/chat",
    "/team/teammate/messages",
  ])
    assert.equal((await app.inject({ url })).statusCode, 404, url);
  assert.equal(
    (await app.inject({ method: "POST", url: "/team" })).statusCode,
    404,
  );
});
