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
  assert.match(prompt, /BASE_PATH/);
});
