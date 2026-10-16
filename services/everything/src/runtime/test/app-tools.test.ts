import assert from "node:assert/strict";
import { test } from "node:test";
import type {
  ArtifactWorkbench,
  WorkbenchContext,
} from "../../artifact/service/artifact-workbench.js";
import { mainAgentPrompt } from "../prompt/main-agent-prompt.js";
import { appToolNames, appTools } from "../tool/app-tools.js";

const agentId = "6f1c1f6e-8c7e-4c4b-9a43-2d8b8f7c8f11";

const context: WorkbenchContext = {
  ownerId: "owner",
  author: { id: "agent", name: "Ada" },
  workspace: "/workspace/agent",
  shared: "/workspace/shared",
  privateDirectory: "/workspace/agent/.pi",
};

test("teammates get every app tool, each described for the model", () => {
  const tools = appTools({} as ArtifactWorkbench, context);
  assert.deepEqual(
    tools.map((tool) => tool.name).sort(),
    [
      "create_app",
      "list_apps",
      "get_app",
      "update_app",
      "delete_app",
      "checkout_app",
      "publish_app",
      "build_app",
      "get_app_build",
      "deploy_app",
      "stop_app",
      "get_app_logs",
      "view_app",
    ].sort(),
  );
  for (const tool of tools) {
    assert.ok(tool.description.length > 40, tool.name);
    assert.doesNotMatch(
      JSON.stringify([
        tool.name,
        tool.label,
        tool.description,
        tool.parameters,
      ]),
      /artifact/i,
    );
    if (tool.name !== appToolNames.create && tool.name !== appToolNames.list) {
      const required: readonly string[] = tool.parameters.required ?? [];
      assert.ok(required.includes("app"), tool.name);
    }
  }
});

test("list_apps returns the shared apps under the name the model uses", async () => {
  const apps = [{ slug: "trip-planner", title: "Trip planner" }];
  const workbench = {
    /** Keep the list scoped to the acting teammate's owner. */
    async list(actingContext: WorkbenchContext) {
      assert.equal(actingContext, context);
      return apps;
    },
  } as unknown as ArtifactWorkbench;
  const list = appTools(workbench, context).find(
    (tool) => tool.name === appToolNames.list,
  )!;
  const result = await list.execute(
    "call",
    {} as never,
    undefined,
    undefined,
    undefined as never,
  );
  assert.deepEqual(JSON.parse((result.content[0] as { text: string }).text), {
    apps,
  });
});

test("deploy_app forwards explicit capability grants and removals, and explains backend credentials", async () => {
  const calls: unknown[] = [];
  const workbench = {
    /** Record the owner-bound deployment settings passed by the teammate tool. */
    deploy: async (acting: WorkbenchContext, app: string, input: unknown) => {
      calls.push([acting.ownerId, app, input]);
      return {};
    },
  } as unknown as ArtifactWorkbench;
  const tool = appTools(workbench, context).find(
    (tool) => tool.name === appToolNames.deploy,
  )!;
  for (const capabilities of [["everything-api"], []])
    await tool.execute(
      "call",
      { app: "app", capabilities } as never,
      undefined,
      undefined,
      undefined as never,
    );
  assert.deepEqual(calls, [
    ["owner", "app", { capabilities: ["everything-api"] }],
    ["owner", "app", { capabilities: [] }],
  ]);
  for (const name of [
    "EVERYTHING_API_URL",
    "EVERYTHING_CLIENT_ID",
    "EVERYTHING_CLIENT_SECRET",
    "EVERYTHING_TOKEN_URL",
  ])
    assert.ok(tool.description.includes(name));
  assert.match(tool.description, /client_credentials/);
  assert.match(tool.description, /app owner/);
});

test("tools act for the teammate and report results as text", async () => {
  const calls: unknown[] = [];
  const workbench = {
    /** Record the app reference and log options passed to the workbench. */
    logs: async (
      actingContext: WorkbenchContext,
      reference: string,
      choice: unknown,
    ) => {
      calls.push([actingContext.author.name, reference, choice]);
      return { text: "" };
    },
    /** Record build polling and cancellation options. */
    waitForBuild: async (
      _context: WorkbenchContext,
      _reference: string,
      number: number,
      waitSeconds: number,
      signal?: AbortSignal,
    ) => {
      calls.push([number, waitSeconds, signal?.aborted]);
      return { number, status: "running" };
    },
  } as unknown as ArtifactWorkbench;
  const tools = appTools(workbench, context);
  const logs = tools.find((tool) => tool.name === appToolNames.logs)!;
  const result = await logs.execute(
    "call",
    { app: "app" } as never,
    undefined,
    undefined,
    undefined as never,
  );
  assert.deepEqual(result.content, [
    { type: "text", text: "The app has no output yet." },
  ]);
  const build = tools.find((tool) => tool.name === appToolNames.getBuild)!;
  const signal = new AbortController().signal;
  const reported = await build.execute(
    "call",
    { app: "app", build: 2, waitSeconds: 30 } as never,
    signal,
    undefined,
    undefined as never,
  );
  assert.match(
    (reported.content[0] as { text: string }).text,
    /"status": "running"/,
  );
  assert.deepEqual(calls, [
    ["Ada", "app", { previous: false, lines: 200 }],
    [2, 30, false],
  ]);
});

test("the prompt explains shared apps and how to change one safely", () => {
  const prompt = mainAgentPrompt({
    id: agentId,
    name: "Ada",
    systemPrompt: "Help.",
  });
  for (const name of [
    appToolNames.list,
    appToolNames.checkout,
    appToolNames.publish,
  ])
    assert.ok(prompt.includes(name), name);
  assert.match(prompt, /basedOn/);
  assert.match(prompt, /## Apps/);
  assert.doesNotMatch(prompt, /artifact/i);
  assert.doesNotMatch(
    mainAgentPrompt(
      { id: agentId, name: "Ada", systemPrompt: "Help." },
      { id: "fork", parentId: "main" },
    ),
    /artifact/i,
  );
  assert.ok(
    prompt.includes(
      `your persistent files are at /workspace/${agentId}, which is also your home directory.`,
    ),
  );
  assert.ok(
    prompt.includes("/workspace/shared is shared with every teammate."),
  );
});

test("dynamic apps are told to serve routes from / and use BASE_PATH only for links", () => {
  const prompt = mainAgentPrompt({
    id: agentId,
    name: "Ada",
    systemPrompt: "Help.",
  });
  const tools = appTools({} as ArtifactWorkbench, context);
  const description = (name: string) =>
    tools.find((tool) => tool.name === name)!.description;
  for (const text of [
    prompt,
    description(appToolNames.build),
    description(appToolNames.deploy),
  ]) {
    assert.match(text, /serve routes from \//i);
    assert.match(text, /without (the app's \/slug|that) prefix/);
    assert.match(text, /BASE_PATH/);
    assert.doesNotMatch(text, /under (the )?BASE_PATH/);
  }
  for (const text of [prompt, description(appToolNames.build)])
    assert.match(text, /absolute links and asset URLs/);
});

test("view_app returns a teammate pass with quoted curl and Chromium commands", async () => {
  const calls: unknown[] = [];
  const host = "http://artifact.everything.svc.cluster.local:8080";
  const workbench = {
    /** Record which app and page the teammate opens. */
    view: async (
      actingContext: WorkbenchContext,
      reference: string,
      input: unknown,
    ) => {
      calls.push([actingContext.ownerId, reference, input]);
      return {
        url: `${host}/site/it's/`,
        browserUrl: `${host}/_teammate-access?token=everything_view_secret`,
        token: "everything_view_secret",
        expiresAt: "2026-10-12T10:10:00.000Z",
      };
    },
  } as unknown as ArtifactWorkbench;
  const view = appTools(workbench, context).find(
    (tool) => tool.name === appToolNames.view,
  )!;
  const result = await view.execute(
    "call",
    { app: "site", path: "/it's/" } as never,
    undefined,
    undefined,
    undefined as never,
  );
  const reported = JSON.parse((result.content[0] as { text: string }).text);
  assert.deepEqual(calls, [["owner", "site", { path: "/it's/" }]]);
  assert.equal(reported.token, "everything_view_secret");
  assert.equal(
    reported.commands.fetch,
    `curl -sS -i -H 'Authorization: Bearer everything_view_secret' '${host}/site/it'\\''s/'`,
  );
  assert.equal(
    reported.commands.screenshot,
    `chromium --headless --no-sandbox --window-size=1280,800 --screenshot=/tmp/screenshot.png '${host}/_teammate-access?token=everything_view_secret'`,
  );
  assert.match(reported.commands.renderedHtml, /--dump-dom '/);
  assert.match(view.description, /share the app's own link instead/);
  assert.match(
    mainAgentPrompt({ id: agentId, name: "Ada", systemPrompt: "Help." }),
    new RegExp(`publish or deploy, open the app with ${appToolNames.view}`),
  );
});
