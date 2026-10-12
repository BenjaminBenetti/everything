import assert from "node:assert/strict";
import { test } from "node:test";
import type {
  ArtifactWorkbench,
  WorkbenchContext,
} from "../../artifact/service/artifact-workbench.js";
import { mainAgentPrompt } from "../prompt/main-agent-prompt.js";
import { artifactToolNames, artifactTools } from "../tool/artifact-tools.js";

const context: WorkbenchContext = {
  ownerId: "owner",
  author: { id: "agent", name: "Ada" },
  workspace: "/agents/agent",
  privateDirectory: "/agents/agent/.pi",
};

test("teammates get every artifact tool, each described for the model", () => {
  const tools = artifactTools({} as ArtifactWorkbench, context);
  assert.deepEqual(
    tools.map((tool) => tool.name).sort(),
    Object.values(artifactToolNames).sort(),
  );
  for (const tool of tools) assert.ok(tool.description.length > 40, tool.name);
});

test("tools act for the teammate and report results as text", async () => {
  const calls: unknown[] = [];
  const workbench = {
    logs: async (
      actingContext: WorkbenchContext,
      reference: string,
      choice: unknown,
    ) => {
      calls.push([actingContext.author.name, reference, choice]);
      return { text: "" };
    },
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
  const tools = artifactTools(workbench, context);
  const logs = tools.find((tool) => tool.name === artifactToolNames.logs)!;
  const result = await logs.execute(
    "call",
    { artifact: "app" } as never,
    undefined,
    undefined,
    undefined as never,
  );
  assert.deepEqual(result.content, [
    { type: "text", text: "The app has no output yet." },
  ]);
  const build = tools.find((tool) => tool.name === artifactToolNames.getBuild)!;
  const signal = new AbortController().signal;
  const reported = await build.execute(
    "call",
    { artifact: "app", build: 2, waitSeconds: 30 } as never,
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

test("the prompt explains shared artifacts and how to change one safely", () => {
  const prompt = mainAgentPrompt({ name: "Ada", systemPrompt: "Help." });
  for (const name of [
    artifactToolNames.list,
    artifactToolNames.checkout,
    artifactToolNames.publish,
  ])
    assert.ok(prompt.includes(name), name);
  assert.match(prompt, /basedOn/);
  assert.match(
    prompt,
    /mounted at \/workspace, which is also your home directory\./,
  );
});

test("dynamic artifacts are told to serve routes from / and use BASE_PATH only for links", () => {
  const prompt = mainAgentPrompt({ name: "Ada", systemPrompt: "Help." });
  const tools = artifactTools({} as ArtifactWorkbench, context);
  const description = (name: string) =>
    tools.find((tool) => tool.name === name)!.description;
  for (const text of [
    prompt,
    description(artifactToolNames.build),
    description(artifactToolNames.deploy),
  ]) {
    assert.match(text, /serve routes from \//i);
    assert.match(text, /without (the artifact's \/slug|that) prefix/);
    assert.match(text, /BASE_PATH/);
    assert.doesNotMatch(text, /under (the )?BASE_PATH/);
  }
  for (const text of [prompt, description(artifactToolNames.build)])
    assert.match(text, /absolute links and asset URLs/);
});

test("view_artifact returns a teammate pass with quoted curl and Chromium commands", async () => {
  const calls: unknown[] = [];
  const host = "http://artifact.everything.svc.cluster.local:8080";
  const workbench = {
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
  const view = artifactTools(workbench, context).find(
    (tool) => tool.name === artifactToolNames.view,
  )!;
  const result = await view.execute(
    "call",
    { artifact: "site", path: "/it's/" } as never,
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
  assert.match(view.description, /share the artifact's own link instead/);
  assert.match(
    mainAgentPrompt({ name: "Ada", systemPrompt: "Help." }),
    new RegExp(
      `publish or deploy, open the artifact with ${artifactToolNames.view}`,
    ),
  );
});
