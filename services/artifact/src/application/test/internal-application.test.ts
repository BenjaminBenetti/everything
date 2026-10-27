import { ArtifactLifecycleService } from "../../artifact/service/artifact-lifecycle-service.js";
import { ArtifactVisibilityService } from "../../artifact/service/artifact-visibility-service.js";
import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { test } from "node:test";
import type { FastifyInstance } from "fastify";
import { ArtifactNotFoundError } from "../../artifact/error/artifact-errors.js";
import { ArtifactLock } from "../../artifact/service/artifact-lock.js";
import { AppApiKeyUnavailableError } from "../../capability/error/app-api-key-errors.js";
import { ArtifactLookup } from "../../artifact/service/artifact-lookup.js";
import { ArtifactService } from "../../artifact/service/artifact-service.js";
import {
  MemoryArtifacts,
  MemoryBuilds,
  MemoryDeployments,
  MemoryRevisions,
} from "../../artifact/test/artifact-fixture.js";
import { FileContentStore } from "../../content/service/file-content-store.js";
import type { DeploymentService } from "../../deployment/service/deployment-service.js";
import type { BuildService } from "../../image/service/build-service.js";
import { RevisionService } from "../../revision/service/revision-service.js";
import type { ViewAccess } from "../../viewing/service/view-access.js";
import { ViewPasses } from "../../viewing/service/view-passes.js";
import { memoryCredentials } from "../../viewing/test/view-fixture.js";
import { createInternalApplication } from "../factory/internal-application.js";

const actor = {
  "x-everything-actor-id": "agent-ada",
  "x-everything-actor-name": "Ada%20Lovelace",
};
const bearer = { authorization: "Bearer valid" };
const fixtureKey = `everything_app_key_${"k".repeat(43)}`;

/** The internal API over in-memory storage and a temporary content store. */
async function application(context: {
  after: (cleanup: () => Promise<void>) => void;
}): Promise<FastifyInstance> {
  const root = await mkdtemp(path.join(tmpdir(), "artifact-internal-"));
  const artifacts = new MemoryArtifacts();
  const revisions = new MemoryRevisions();
  const content = new FileContentStore(root);
  const lookup = new ArtifactLookup(artifacts);
  const lock = new ArtifactLock();
  const app = await createInternalApplication({
    verifier: {
      verify: async (token) => {
        if (token !== "valid") throw new Error("invalid");
        return { subject: "everything-service" };
      },
    },
    artifacts: new ArtifactService(
      artifacts,
      revisions,
      new MemoryBuilds(),
      new MemoryDeployments(),
      { runtimes: async () => new Map() },
      {
        builds: { cancel: async () => {} },
        workloads: { remove: async () => {} },
      },
      lookup,
      lock,
      {
        artifact: "http://artifacts.test",
        publicApps: "http://public.apps.test",
      },
    ),
    lifecycle: new ArtifactLifecycleService(artifacts, lookup, lock, {
      reconcile: async () => {},
    }),
    visibility: new ArtifactVisibilityService(artifacts, lookup, lock),
    revisions: new RevisionService(artifacts, revisions, content, lookup, lock),
    builds: { source: async () => undefined } as unknown as BuildService,
    deployments: {} as DeploymentService,
    content,
    access: {
      grant: async (_owner, input) => ({ url: `view:${input.slug}` }),
    } as ViewAccess,
    passes: new ViewPasses(lookup, memoryCredentials().passes),
    apiKeys: {
      /** Reveal one fixture key; anything else is unavailable, as for a disabled app. */
      reveal: async (ownerId, reference) => {
        if (ownerId !== "owner") throw new ArtifactNotFoundError();
        if (reference !== "hooks") throw new AppApiKeyUnavailableError();
        return { apiKey: fixtureKey };
      },
    },
    readiness: async () => {},
  });
  context.after(async () => {
    await app.close();
    await rm(root, { recursive: true, force: true });
  });
  return app;
}

test("the internal API requires a service token, and changes require the acting teammate", async (context) => {
  const app = await application(context);
  assert.equal((await app.inject({ url: "/health/ready" })).statusCode, 200);
  assert.equal(
    (await app.inject({ url: "/internal/v1/owners/owner/artifacts" }))
      .statusCode,
    401,
  );
  const anonymous = await app.inject({
    method: "POST",
    url: "/internal/v1/owners/owner/artifacts",
    headers: bearer,
    payload: { slug: "site", kind: "static", title: "Site", description: "" },
  });
  assert.deepEqual(
    [anonymous.statusCode, anonymous.json().code],
    [400, "MISSING_ACTOR"],
  );
  const invalid = await app.inject({
    method: "POST",
    url: "/internal/v1/owners/owner/artifacts",
    headers: { ...bearer, ...actor },
    payload: {
      slug: "Not A Slug",
      kind: "static",
      title: "Site",
      description: "",
    },
  });
  assert.equal(invalid.statusCode, 400);
});

test("deployment requests reject unknown, duplicate, and malformed capabilities before provisioning", async (context) => {
  const app = await application(context);
  for (const capabilities of [
    ["unknown"],
    ["everything-api", "everything-api"],
    "everything-api",
    [1],
  ]) {
    const response = await app.inject({
      method: "POST",
      url: "/internal/v1/owners/owner/artifacts/app/deployments",
      headers: { ...bearer, ...actor },
      payload: { capabilities },
    });
    assert.equal(response.statusCode, 400);
  }
});

test("uploading, publishing, checking out, and opening a static artifact", async (context) => {
  const app = await application(context);
  const created = await app.inject({
    method: "POST",
    url: "/internal/v1/owners/owner/artifacts",
    headers: { ...bearer, ...actor },
    payload: {
      slug: "site",
      kind: "static",
      title: "Site",
      description: "Docs",
    },
  });
  assert.equal(created.statusCode, 201);
  assert.deepEqual(created.json().createdBy, {
    id: "agent-ada",
    name: "Ada Lovelace",
  });
  assert.equal(created.json().url, "http://artifacts.test/site/");
  assert.equal(created.json().status, "unpublished");

  const body = "<h1>Hello</h1>";
  const sha256 = createHash("sha256").update(body).digest("hex");
  const missing = await app.inject({
    method: "POST",
    url: "/internal/v1/content/missing",
    headers: bearer,
    payload: { hashes: [sha256] },
  });
  assert.deepEqual(missing.json(), { missing: [sha256] });
  const uploaded = await app.inject({
    method: "PUT",
    url: `/internal/v1/content/${sha256}`,
    headers: { ...bearer, "content-type": "application/octet-stream" },
    payload: body,
  });
  assert.equal(uploaded.statusCode, 204);
  const file = {
    path: "index.html",
    sha256,
    size: body.length,
    executable: false,
  };
  const published = await app.inject({
    method: "POST",
    url: "/internal/v1/owners/owner/artifacts/site/revisions",
    headers: { ...bearer, ...actor },
    payload: { files: [file], basedOn: 0 },
  });
  assert.equal(published.statusCode, 201);
  assert.deepEqual(
    [
      published.json().status,
      published.json().release,
      published.json().revisions.length,
    ],
    ["live", 1, 1],
  );
  const source = await app.inject({
    url: "/internal/v1/owners/owner/artifacts/site/source",
    headers: bearer,
  });
  assert.deepEqual(source.json(), {
    origin: "revision",
    number: 1,
    release: 1,
    files: [file],
  });
  const downloaded = await app.inject({
    url: `/internal/v1/content/${sha256}`,
    headers: bearer,
  });
  assert.equal(downloaded.body, body);
  const listed = await app.inject({
    url: "/internal/v1/owners/owner/artifacts",
    headers: bearer,
  });
  assert.equal(listed.json().artifacts.length, 1);
  const foreign = await app.inject({
    url: "/internal/v1/owners/other/artifacts/site",
    headers: bearer,
  });
  assert.equal(foreign.statusCode, 404);
  const view = await app.inject({
    method: "POST",
    url: "/internal/v1/owners/owner/views",
    headers: bearer,
    payload: { slug: "site" },
  });
  assert.deepEqual(view.json(), { url: "view:site" });
  const passUrl = "/internal/v1/owners/owner/artifacts/site/view-passes";
  const pass = await app.inject({
    method: "POST",
    url: passUrl,
    headers: bearer,
    payload: { path: "/index.html" },
  });
  assert.equal(pass.statusCode, 201);
  assert.equal(pass.headers["cache-control"], "no-store");
  assert.equal(pass.json().path, "/site/index.html");
  assert.match(
    pass.json().signInPath,
    /^\/_teammate-access\?token=everything_view_/,
  );
  assert.equal(
    (await app.inject({ method: "POST", url: passUrl, payload: {} }))
      .statusCode,
    401,
  );
  const foreignPass = await app.inject({
    method: "POST",
    url: "/internal/v1/owners/other/artifacts/site/view-passes",
    headers: bearer,
    payload: {},
  });
  assert.deepEqual(
    [foreignPass.statusCode, foreignPass.json().code],
    [404, "ARTIFACT_NOT_FOUND"],
  );
  const outside = await app.inject({
    method: "POST",
    url: passUrl,
    headers: bearer,
    payload: { path: "//evil.test/" },
  });
  assert.deepEqual(
    [outside.statusCode, outside.json().code],
    [400, "INVALID_VIEW_PATH"],
  );
  const endpoint = "/internal/v1/owners/owner/artifacts/site";
  const liveDelete = await app.inject({
    method: "DELETE",
    url: endpoint + "?requireStopped=true",
    headers: { ...bearer, ...actor },
  });
  assert.equal(liveDelete.statusCode, 409);
  assert.equal(liveDelete.json().code, "APP_MUST_BE_STOPPED");
  for (const [action, status] of [
    ["stop", "stopped"],
    ["start", "live"],
    ["stop", "stopped"],
  ]) {
    const changed = await app.inject({
      method: "POST",
      url: endpoint + "/" + action,
      headers: { ...bearer, ...actor },
    });
    assert.equal(changed.statusCode, 200);
    assert.equal(changed.json().status, status);
    assert.equal(changed.json().release, 1);
  }
  const foreignStart = await app.inject({
    method: "POST",
    url: "/internal/v1/owners/other/artifacts/site/start",
    headers: { ...bearer, ...actor },
  });
  assert.equal(foreignStart.statusCode, 404);
  const removed = await app.inject({
    method: "DELETE",
    url: endpoint + "?requireStopped=true",
    headers: { ...bearer, ...actor },
  });
  assert.equal(removed.statusCode, 204);
});

test("the owner's API key is revealed only with a service token, never cached, and only for an enabled app", async (context) => {
  const app = await application(context);
  const url = "/internal/v1/owners/owner/artifacts/hooks/api-key";
  assert.equal((await app.inject({ url })).statusCode, 401);
  const revealed = await app.inject({ url, headers: bearer });
  assert.equal(revealed.statusCode, 200);
  assert.equal(revealed.headers["cache-control"], "no-store");
  assert.deepEqual(revealed.json(), { apiKey: fixtureKey });
  const foreign = await app.inject({
    url: "/internal/v1/owners/other/artifacts/hooks/api-key",
    headers: bearer,
  });
  assert.deepEqual(
    [foreign.statusCode, foreign.json().code],
    [404, "ARTIFACT_NOT_FOUND"],
  );
  const disabled = await app.inject({
    url: "/internal/v1/owners/owner/artifacts/plain/api-key",
    headers: bearer,
  });
  assert.deepEqual(
    [disabled.statusCode, disabled.json().code],
    [409, "APP_API_KEY_UNAVAILABLE"],
  );
  assert.doesNotMatch(disabled.body, /everything_app_key_/);
});

test("apps start private, only the owner's own request makes them public, and releases keep the choice", async (context) => {
  const app = await application(context);
  const owner = {
    "x-everything-actor-id": "owner",
    "x-everything-actor-name": "You",
  };
  const endpoint = "/internal/v1/owners/owner/artifacts/site";
  // Every creation path ignores nothing silently: a body that names visibility is refused outright.
  const smuggled = await app.inject({
    method: "POST",
    url: "/internal/v1/owners/owner/artifacts",
    headers: { ...bearer, ...actor },
    payload: {
      slug: "site",
      kind: "static",
      title: "Site",
      description: "",
      visibility: "public",
    },
  });
  assert.equal(smuggled.statusCode, 400);
  const created = await app.inject({
    method: "POST",
    url: "/internal/v1/owners/owner/artifacts",
    headers: { ...bearer, ...actor },
    payload: { slug: "site", kind: "static", title: "Site", description: "" },
  });
  assert.equal(created.statusCode, 201);
  assert.equal(created.json().visibility, "private");

  // Edits, releases, and lifecycle requests cannot carry visibility either.
  for (const [method, url, payload] of [
    ["PATCH", endpoint, { title: "Site", visibility: "public" }],
    ["PATCH", endpoint, { visibility: "public" }],
    ["POST", `${endpoint}/revisions`, { files: [], visibility: "public" }],
    ["POST", `${endpoint}/deployments`, { visibility: "public" }],
    [
      "POST",
      `${endpoint}/builds`,
      { files: [], dockerfile: "Dockerfile", buildArgs: {}, public: true },
    ],
  ] as const) {
    const response = await app.inject({
      method,
      url,
      headers: { ...bearer, ...actor },
      payload,
    });
    assert.equal(response.statusCode, 400, `${method} ${url}`);
  }

  // A teammate acting for the owner is refused, and so is any other author.
  for (const author of [actor, { ...actor, "x-everything-actor-id": "x" }]) {
    const refused = await app.inject({
      method: "PUT",
      url: `${endpoint}/visibility`,
      headers: { ...bearer, ...author },
      payload: { visibility: "public" },
    });
    assert.deepEqual(
      [refused.statusCode, refused.json().code],
      [403, "OWNER_ACTION_REQUIRED"],
    );
  }
  const unsigned = await app.inject({
    method: "PUT",
    url: `${endpoint}/visibility`,
    headers: owner,
    payload: { visibility: "public" },
  });
  assert.equal(unsigned.statusCode, 401);
  for (const payload of [
    { visibility: "everyone" },
    { visibility: "public", ownerId: "owner" },
    {},
  ]) {
    const malformed = await app.inject({
      method: "PUT",
      url: `${endpoint}/visibility`,
      headers: { ...bearer, ...owner },
      payload,
    });
    assert.equal(malformed.statusCode, 400);
  }
  // Another owner's scope cannot see the app, even when it names itself the author.
  const foreign = await app.inject({
    method: "PUT",
    url: "/internal/v1/owners/other/artifacts/site/visibility",
    headers: {
      ...bearer,
      "x-everything-actor-id": "other",
      ...{ "x-everything-actor-name": "Other" },
    },
    payload: { visibility: "public" },
  });
  assert.equal(foreign.statusCode, 404);
  assert.equal(
    (await app.inject({ url: endpoint, headers: bearer })).json().visibility,
    "private",
  );

  const madePublic = await app.inject({
    method: "PUT",
    url: `${endpoint}/visibility`,
    headers: { ...bearer, ...owner },
    payload: { visibility: "public" },
  });
  assert.equal(madePublic.statusCode, 200);
  assert.deepEqual(
    [madePublic.json().visibility, madePublic.json().updatedBy],
    ["public", { id: "owner", name: "You" }],
  );
  assert.equal(
    (
      await app.inject({
        method: "GET",
        url: `${endpoint}/visibility`,
        headers: bearer,
      })
    ).statusCode,
    404,
    "there is no read or GET form of the change",
  );

  // A teammate's later release, edit, stop, and start keep the owner's choice.
  const body = "<h1>Public</h1>";
  const sha256 = createHash("sha256").update(body).digest("hex");
  await app.inject({
    method: "PUT",
    url: `/internal/v1/content/${sha256}`,
    headers: { ...bearer, "content-type": "application/octet-stream" },
    payload: body,
  });
  const released = await app.inject({
    method: "POST",
    url: `${endpoint}/revisions`,
    headers: { ...bearer, ...actor },
    payload: {
      files: [
        { path: "index.html", sha256, size: body.length, executable: false },
      ],
    },
  });
  assert.deepEqual(
    [released.statusCode, released.json().visibility, released.json().status],
    [201, "public", "live"],
  );
  for (const [method, url, payload] of [
    ["PATCH", endpoint, { title: "Renamed" }],
    ["POST", `${endpoint}/stop`, undefined],
    ["POST", `${endpoint}/start`, undefined],
  ] as const) {
    const response = await app.inject({
      method,
      url,
      headers: { ...bearer, ...actor },
      ...(payload ? { payload } : {}),
    });
    assert.equal(response.statusCode, 200, `${method} ${url}`);
    assert.equal(response.json().visibility, "public", `${method} ${url}`);
  }
  const listed = await app.inject({
    url: "/internal/v1/owners/owner/artifacts",
    headers: bearer,
  });
  assert.equal(listed.json().artifacts[0].visibility, "public");

  // The owner can make it private again; repeating a choice changes nothing.
  for (const visibility of ["private", "private"] as const) {
    const changed = await app.inject({
      method: "PUT",
      url: `${endpoint}/visibility`,
      headers: { ...bearer, ...owner },
      payload: { visibility },
    });
    assert.deepEqual(
      [changed.statusCode, changed.json().visibility],
      [200, "private"],
    );
  }

  // Deleting and recreating the slug gives a new, private app.
  await app.inject({
    method: "PUT",
    url: `${endpoint}/visibility`,
    headers: { ...bearer, ...owner },
    payload: { visibility: "public" },
  });
  await app.inject({
    method: "POST",
    url: `${endpoint}/stop`,
    headers: { ...bearer, ...owner },
  });
  const removed = await app.inject({
    method: "DELETE",
    url: endpoint + "?requireStopped=true",
    headers: { ...bearer, ...owner },
  });
  assert.equal(removed.statusCode, 204);
  const recreated = await app.inject({
    method: "POST",
    url: "/internal/v1/owners/owner/artifacts",
    headers: { ...bearer, ...actor },
    payload: { slug: "site", kind: "static", title: "Again", description: "" },
  });
  assert.deepEqual(
    [recreated.statusCode, recreated.json().visibility],
    [201, "private"],
  );
  assert.notEqual(recreated.json().id, created.json().id);
});
