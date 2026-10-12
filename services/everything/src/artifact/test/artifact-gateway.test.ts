import assert from "node:assert/strict";
import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { test } from "node:test";
import type { ArtifactDetails } from "@everything/artifact-contracts";
import { authenticatedTestServer } from "../../http/test/test-server.js";
import { HttpArtifactGateway } from "../adapter/http-artifact-gateway.js";
import { artifactController } from "../controller/artifact-controller.js";
import { ArtifactRequestFailure } from "../error/artifact-errors.js";
import type { ArtifactGateway } from "../interface/artifact-gateway.js";
import { ArtifactLibraryService } from "../service/artifact-library-service.js";
import { ArtifactWorkbench } from "../service/artifact-workbench.js";

const tokens = { token: async () => "service-token" };

test("the gateway authenticates as the service and names the acting teammate", async () => {
  const requests: { url: string; init: RequestInit }[] = [];
  const gateway = new HttpArtifactGateway(
    "http://artifact:8081",
    tokens,
    async (url, init = {}) => {
      requests.push({ url: String(url), init });
      return Response.json({ id: "a" });
    },
  );
  await gateway.update(
    { ownerId: "owner/1", author: { id: "agent-1", name: "Zoë Søren" } },
    "site",
    { title: "New" },
  );
  const headers = new Headers(requests[0]!.init.headers);
  assert.equal(
    requests[0]!.url,
    "http://artifact:8081/internal/v1/owners/owner%2F1/artifacts/site",
  );
  assert.equal(requests[0]!.init.method, "PATCH");
  assert.equal(headers.get("authorization"), "Bearer service-token");
  assert.equal(headers.get("x-everything-actor-id"), "agent-1");
  assert.equal(
    decodeURIComponent(headers.get("x-everything-actor-name")!),
    "Zoë Søren",
  );
  assert.equal(requests[0]!.init.body, JSON.stringify({ title: "New" }));
});

test("the gateway reports the artifact service's failures with their codes and messages", async () => {
  const gateway = new HttpArtifactGateway(
    "http://artifact:8081",
    tokens,
    async () =>
      Response.json(
        { code: "RELEASE_CONFLICT", message: "Release 3 by Ada is live now." },
        { status: 409 },
      ),
  );
  await assert.rejects(gateway.get("owner", "site"), (error: unknown) => {
    assert.ok(error instanceof ArtifactRequestFailure);
    assert.deepEqual(
      [error.status, error.code, error.message],
      [409, "RELEASE_CONFLICT", "Release 3 by Ada is live now."],
    );
    return true;
  });
  const opaque = new HttpArtifactGateway(
    "http://artifact:8081",
    tokens,
    async () => new Response("bad gateway", { status: 502 }),
  );
  await assert.rejects(opaque.list("owner"), {
    code: "ARTIFACT_SERVICE_ERROR",
  });
});

test("publishing uploads only content the artifact service lacks, then publishes every file", async (context) => {
  const workspace = await mkdtemp(path.join(tmpdir(), "artifact-workbench-"));
  context.after(() => rm(workspace, { recursive: true, force: true }));
  await mkdir(path.join(workspace, "site"));
  await writeFile(path.join(workspace, "site/a.html"), "same");
  await writeFile(path.join(workspace, "site/b.html"), "same");
  await writeFile(path.join(workspace, "site/c.html"), "different");
  const uploaded: string[] = [];
  let published: unknown;
  const gateway = {
    missingContent: async (hashes: readonly string[]) => [...new Set(hashes)],
    uploadContent: async (hash: string) => void uploaded.push(hash),
    publish: async (_actor: unknown, _reference: string, input: unknown) => {
      published = input;
      return { release: 1 } as ArtifactDetails;
    },
  } as unknown as ArtifactGateway;
  const result = await new ArtifactWorkbench(gateway).publish(
    {
      ownerId: "owner",
      author: { id: "agent", name: "Ada" },
      workspace,
      privateDirectory: path.join(workspace, ".pi"),
    },
    "site",
    { directory: "site", basedOn: 0 },
  );
  assert.equal(uploaded.length, 2, "identical files are uploaded once");
  const input = published as { files: { path: string }[]; basedOn: number };
  assert.deepEqual(
    input.files.map((file) => file.path),
    ["a.html", "b.html", "c.html"],
  );
  assert.equal(input.basedOn, 0);
  assert.equal("absolutePath" in input.files[0]!, false);
  assert.deepEqual(result.skipped, []);
});

test("browser endpoints list artifacts and open them, hiding artifact service details", async (context) => {
  const failures: Error[] = [];
  const library = new ArtifactLibraryService({
    list: async (ownerId) => {
      if (failures.length) throw failures.shift();
      return [{ slug: `for-${ownerId}` } as never];
    },
    view: async (_ownerId, input) => {
      if (input.slug === "missing")
        throw new ArtifactRequestFailure(
          404,
          "ARTIFACT_NOT_FOUND",
          "Artifact not found.",
        );
      return { url: `http://artifacts.test/_access?code=${input.slug}` };
    },
  });
  const app = authenticatedTestServer();
  context.after(() => app.close());
  await artifactController(app, library);
  const listed = await app.inject({ url: "/artifacts" });
  assert.deepEqual(listed.json(), { artifacts: [{ slug: "for-owner" }] });
  const opened = await app.inject({
    method: "POST",
    url: "/artifact-views",
    payload: { slug: "site", path: "/docs/" },
  });
  assert.equal(opened.json().url, "http://artifacts.test/_access?code=site");
  const missing = await app.inject({
    method: "POST",
    url: "/artifact-views",
    payload: { slug: "missing" },
  });
  assert.deepEqual(
    [missing.statusCode, missing.json().code],
    [404, "ARTIFACT_NOT_FOUND"],
  );
  const outside = await app.inject({
    method: "POST",
    url: "/artifact-views",
    payload: { slug: "site", path: "//evil.test/" },
  });
  assert.equal(outside.statusCode, 400);
  failures.push(new Error("connect ECONNREFUSED"));
  const unavailable = await app.inject({ url: "/artifacts" });
  assert.deepEqual(
    [unavailable.statusCode, unavailable.json().code],
    [503, "ARTIFACTS_UNAVAILABLE"],
  );
});
