import assert from "node:assert/strict";
import { test } from "node:test";
import { authenticatedTestServer } from "../../http/test/test-server.js";
import { agentActivityController } from "../controller/agent-activity-controller.js";
import { AgentActivityService } from "../service/agent-activity-service.js";
import { AgentNotFoundError } from "../error/agent-errors.js";

test("recent teammates and explicit interactions use the authenticated owner and server clock", async (context) => {
  const app = authenticatedTestServer();
  context.after(() => app.close());
  const visits: unknown[] = [];
  const at = "2026-10-15T12:00:00.000Z";
  const agent = {
    id: "00000000-0000-4000-8000-000000000001",
    ownerId: "owner",
    name: "Avery",
    systemPrompt: "Help",
    avatarId: "avatar-01" as const,
    inference: null,
    createdAt: at,
    lastInteractedAt: at,
  };
  const activity = new AgentActivityService(
    {
      /** Return internal metadata only for the requesting owner. */
      async list(scope) {
        assert.deepEqual(scope, { ownerId: "owner" });
        return [agent];
      },
      /** Record the owner, teammate, and trusted server timestamp. */
      async touch(scope, id, timestamp) {
        if (id !== agent.id) throw new AgentNotFoundError();
        visits.push([scope, id, timestamp]);
      },
    },
    () => Date.parse(at),
  );
  await agentActivityController(app, activity);
  const recent = await app.inject({ url: "/agents/recent" });
  assert.equal(recent.statusCode, 200);
  const { ownerId: _owner, lastInteractedAt: _time, ...publicAgent } = agent;
  assert.deepEqual(recent.json(), { agents: [publicAgent] });
  assert.deepEqual(
    visits,
    [],
    "Fetching recent teammates never changes their order",
  );
  const opened = await app.inject({
    method: "POST",
    url: `/agents/${agent.id}/interactions`,
  });
  assert.equal(opened.statusCode, 204);
  assert.deepEqual(visits, [[{ ownerId: "owner" }, agent.id, at]]);
  for (const [id, expected] of [
    ["missing", 400],
    ["00000000-0000-4000-8000-000000000002", 404],
  ] as const) {
    const response = await app.inject({
      method: "POST",
      url: `/agents/${id}/interactions`,
    });
    assert.equal(response.statusCode, expected);
  }
});
