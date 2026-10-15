import assert from "node:assert/strict";
import { test } from "node:test";
import type { WorkspaceReference } from "@everything/workspace-contracts/instance";
import { authenticatedTestServer } from "../../http/test/test-server.js";
import { workspaceInstanceController } from "../controller/workspace-instance-controller.js";
import { WorkspaceInstanceConflictError } from "../error/workspace-instance-errors.js";

test("validates explicit instance references and maps lifecycle conflicts", async (context) => {
  const app = authenticatedTestServer();
  context.after(() => app.close());
  const calls: WorkspaceReference[] = [];
  await workspaceInstanceController(app, {
    /** An empty directory remains a successful listing. */
    async list() {
      return [];
    },
    /** Record start requests for validation assertions. */
    async start(workspace) {
      calls.push(workspace);
    },
    /** Stop requests need no runtime in this transport test. */
    async stop() {},
    /** A running workspace cannot be deleted. */
    async delete() {
      throw new WorkspaceInstanceConflictError();
    },
  });
  assert.deepEqual((await app.inject({ url: "/workspaces" })).json(), {
    workspaces: [],
  });
  for (const payload of [
    {},
    { type: "web" },
    { type: "web", name: "../all" },
    { type: "..", name: "dev" },
    { type: "web", name: "dev", all: true },
    { type: "web", name: null },
    { type: "web", name: "dev\u0000" },
  ]) {
    assert.equal(
      (await app.inject({ method: "POST", url: "/workspaces/start", payload }))
        .statusCode,
      400,
    );
  }
  assert.deepEqual(calls, []);
  const payload = { type: "web", name: "dev-1" };
  assert.equal(
    (await app.inject({ method: "POST", url: "/workspaces/start", payload }))
      .statusCode,
    204,
  );
  assert.deepEqual(calls, [payload]);
  const deletion = await app.inject({
    method: "DELETE",
    url: "/workspaces",
    payload,
  });
  assert.equal(deletion.statusCode, 409);
  assert.equal(deletion.json().code, "WORKSPACE_INSTANCE_CONFLICT");
});
