import { testConversationSearch } from "../../runtime/test/conversation-search-fixtures.js";
import { testApiDocumentation } from "../../runtime/test/api-documentation-fixtures.js";
import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { test } from "node:test";
import type { ChatMessage } from "@everything/conversation-contracts";
import { AgentNotFoundError } from "../../agent/error/agent-errors.js";
import type { AgentDefinition } from "../../agent/model/agent.js";
import type { ArtifactWorkbench } from "../../artifact/service/artifact-workbench.js";
import { ConversationService } from "../../conversation/service/conversation-service.js";
import { PiInferenceRuntimeFactory } from "../../runtime/adapter/pi-inference-runtime.js";
import { PiModelCapabilities } from "../../runtime/adapter/pi-model-capabilities.js";
import { PiSessionFactory } from "../../runtime/adapter/pi-session-factory.js";
import { createModelRuntime } from "../../runtime/factory/model-runtime.js";
import { FileSystemWorkspaces } from "../../workspace/service/file-system-workspaces.js";
import { JobRuns } from "../service/job-runs.js";
import { JobService } from "../service/job-service.js";
import { jobToolNames } from "../tool/job-tools.js";
import { FakeClock, FakeWakeups, MemoryJobs } from "./job-fixtures.js";

/** A tool call the fake model makes, or its final text. */
type Step = { name: string; input: unknown } | { text: string };

/** One OpenAI-compatible streamed completion: a single tool call or a final text reply. */
function completion(step: Step): Response {
  const delta =
    "name" in step
      ? {
          tool_calls: [
            {
              index: 0,
              id: `call-${randomUUID()}`,
              type: "function",
              function: {
                name: step.name,
                arguments: JSON.stringify(step.input),
              },
            },
          ],
        }
      : { content: step.text };
  return new Response(
    `data: ${JSON.stringify({ id: "completion", object: "chat.completion.chunk", created: 1, model: "o3-mini", choices: [{ index: 0, delta: { role: "assistant", ...delta }, finish_reason: "name" in step ? "tool_calls" : "stop" }] })}\n\ndata: [DONE]\n\n`,
    { headers: { "content-type": "text/event-stream" } },
  );
}

/** The text of a provider message's content, whichever shape it was sent in. */
function text(content: unknown): string {
  if (typeof content === "string") return content;
  if (Array.isArray(content))
    return content.map((part: { text?: string }) => part.text ?? "").join("");
  return JSON.stringify(content);
}

/** Wait for asynchronous work with a bounded deadline. */
async function until(predicate: () => boolean): Promise<void> {
  const deadline = Date.now() + 15_000;
  while (!predicate()) {
    assert.ok(Date.now() < deadline, "The conversation did not settle");
    await new Promise((resolve) => setTimeout(resolve, 10));
  }
}

test("a fake model configures jobs through main's registered job tools, scoped to its saved teammate, and forks don't get them", async (context) => {
  const directory = await mkdtemp(path.join(tmpdir(), "job-tools-"));
  const agentId = randomUUID();
  const siblingId = randomUUID();
  const definition: AgentDefinition = {
    id: agentId,
    ownerId: "owner",
    name: "Jobs tool teammate",
    systemPrompt: "Keep an eye on the project",
    avatarId: "avatar-01",
    createdAt: "2026-11-01T00:00:00.000Z",
    inference: {
      provider: "openai-compatible",
      model: "o3-mini",
      effort: "high",
    },
  };
  const agents = {
    get: async (ownerId: string, id: string) => {
      if (ownerId !== "owner" || (id !== agentId && id !== siblingId))
        throw new AgentNotFoundError();
      return { ...definition, id };
    },
    delete: async () => {},
  };

  // The real job service over in-memory storage that applies the repository's rules.
  const clock = new FakeClock("2026-11-05T10:00:00.000Z");
  const store = new MemoryJobs(clock.now, {
    [agentId]: "owner",
    [siblingId]: "owner",
  });
  const runs = new JobRuns(
    new FakeWakeups(),
    store,
    () => {},
    undefined,
    clock.now,
  );
  const jobs = new JobService(agents, store, runs, clock.now);
  const sibling = await jobs.create(
    { ownerId: "owner", agentId: siblingId },
    {
      name: "Sibling's job",
      instructions: "Not yours.",
      schedule: { type: "interval", seconds: 3600 },
    },
  );

  // The fake model: main walks through the job tools one call at a time, reading each result.
  const mainTools: { name: string; parameters: unknown }[] = [];
  const forkToolNames: string[][] = [];
  const results: string[] = [];
  let createdId = "";
  const script: (() => Step)[] = [
    () => ({
      name: jobToolNames.create,
      input: {
        name: "Morning PRs",
        instructions: "List open pull requests waiting for my review.",
        schedule: {
          type: "cron",
          expression: "0 9 * * 1-5",
          timezone: "Europe/Paris",
        },
      },
    }),
    () => ({
      name: jobToolNames.create,
      input: {
        name: "Elsewhere",
        instructions: "Check.",
        schedule: { type: "interval", seconds: 900 },
        agent_id: siblingId,
      },
    }),
    () => ({
      name: jobToolNames.update,
      input: { id: sibling.id, name: "Taken" },
    }),
    () => ({ name: jobToolNames.list, input: {} }),
    () => ({
      name: jobToolNames.update,
      input: { id: createdId, enabled: false },
    }),
    () => {
      clock.advance(24 * 60 * 60_000);
      return {
        name: jobToolNames.update,
        input: { id: createdId, enabled: true },
      };
    },
    () => ({
      name: jobToolNames.create,
      input: {
        name: "Too often",
        instructions: "Check.",
        schedule: {
          type: "cron",
          expression: "*/2 * * * *",
          timezone: "Europe/Paris",
        },
      },
    }),
    () => ({ name: "fork", input: { task: "CHECK_FORK_TOOLS" } }),
    () => ({ name: jobToolNames.delete, input: { id: createdId } }),
    () => ({ name: "send_message", input: { text: "Jobs configured." } }),
  ];
  const inference = new PiInferenceRuntimeFactory(
    {
      access: async () => ({
        credential: { apiKey: "fixture-key" },
        baseUrl: "http://model.test/v1",
        model: "o3-mini",
      }),
    },
    { select: async () => ({ id: "o3-mini", name: "Test" }) },
    new PiModelCapabilities(await createModelRuntime()),
    async (_input, init) => {
      const body = JSON.parse(String(init?.body)) as {
        messages: { role: string; content?: unknown }[];
        tools?: {
          function: { name: string; parameters: unknown };
        }[];
      };
      const names = (body.tools ?? []).map((tool) => tool.function.name);
      if (text(body.messages[0]!.content).includes("You are private fork ")) {
        forkToolNames.push(names);
        return completion({ text: "FORK_TOOLS_CHECKED" });
      }
      if (!mainTools.length)
        mainTools.push(
          ...(body.tools ?? []).map((tool) => ({
            name: tool.function.name,
            parameters: tool.function.parameters,
          })),
        );
      const last = body.messages.at(-1)!;
      if (last.role === "tool") {
        const output = text(last.content);
        results.push(output);
        if (results.length === 1) createdId = JSON.parse(output).id as string;
      } else if (text(last.content).includes("finished:")) {
        // The fork's reply wakes main after its turn; it needs no further tools.
        return completion({ text: "Noted." });
      }
      const next = script[results.length];
      return completion(next ? next() : { text: "Done." });
    },
  );
  const visible: ChatMessage[] = [];
  const workspaces = new FileSystemWorkspaces(directory);
  const conversations = new ConversationService(
    agents,
    {
      append: async (_scope, role, text) => ({
        id: randomUUID(),
        role,
        text,
        createdAt: new Date().toISOString(),
        attachments: [],
      }),
      deliver: async (_scope, text) => {
        const message = {
          id: randomUUID(),
          role: "assistant" as const,
          text,
          createdAt: new Date().toISOString(),
          attachments: [],
        };
        visible.push(message);
        return message;
      },
      page: async () => ({ messages: visible, nextCursor: null }),
    },
    new PiSessionFactory(
      inference,
      workspaces,
      {} as ArtifactWorkbench,
      {
        read: async () => {
          throw new Error("Unexpected file read");
        },
        write: async () => {
          throw new Error("Unexpected file write");
        },
        bash: async () => {
          throw new Error("Unexpected Bash");
        },
      },
      { endpoint: undefined, whenRunning: () => new Promise(() => {}) },
      testApiDocumentation,
      testConversationSearch,
      undefined,
      undefined,
      undefined,
      jobs,
    ),
    workspaces,
  );
  context.after(async () => {
    await conversations.close();
    await rm(directory, { recursive: true, force: true });
  });

  await conversations.send("owner", agentId, {
    text: "Every weekday at 9 in Paris, list my open PRs.",
  });
  await until(
    () =>
      visible.length === 1 &&
      forkToolNames.length === 1 &&
      results.length === script.length,
  );

  // Main's provider request advertises the four tools with the job API's own argument schemas.
  for (const name of Object.values(jobToolNames))
    assert.ok(
      mainTools.some((tool) => tool.name === name),
      name,
    );
  const create = mainTools.find((tool) => tool.name === jobToolNames.create)!
    .parameters as {
    required: string[];
    additionalProperties: boolean;
    properties: object;
  };
  assert.deepEqual([...create.required].sort(), [
    "instructions",
    "name",
    "schedule",
  ]);
  assert.equal(create.additionalProperties, false);
  assert.doesNotMatch(
    JSON.stringify(Object.keys(create.properties)),
    /owner|agent/i,
  );
  // A fork's request has its normal tools but none of the job tools.
  assert.ok(forkToolNames[0]!.includes("send_message"));
  for (const name of Object.values(jobToolNames))
    assert.ok(!forkToolNames[0]!.includes(name), name);

  const [
    created,
    smuggled,
    sibling404,
    listed,
    paused,
    resumed,
    invalid,
    forked,
    deleted,
  ] = results;
  // Created for main's saved teammate, with the next weekday 9:00 in Paris.
  assert.equal(JSON.parse(created!).nextRunAt, "2026-11-06T08:00:00.000Z");
  assert.ok(!created!.includes(agentId));
  // Pi refused the smuggled teammate ID before the job service ran.
  assert.match(smuggled!, /Validation failed for tool "create_job"/);
  // Another teammate's job looks missing, and it is unchanged.
  assert.match(sibling404!, /This job wasn't found\./);
  assert.equal(store.jobs.get(sibling.id)!.name, "Sibling's job");
  // The listing has only main's teammate's job.
  assert.deepEqual(
    JSON.parse(listed!).jobs.map((job: { id: string }) => job.id),
    [createdId],
  );
  assert.deepEqual(
    [JSON.parse(paused!).enabled, JSON.parse(paused!).nextRunAt],
    [false, null],
  );
  // Resumed a day later: timing restarts from Friday 11:00 in Paris, so Monday at 9:00.
  assert.deepEqual(
    [JSON.parse(resumed!).enabled, JSON.parse(resumed!).nextRunAt],
    [true, "2026-11-09T08:00:00.000Z"],
  );
  assert.match(invalid!, /Cron matches must be at least five minutes apart\./);
  assert.match(forked!, /"status"/);
  assert.deepEqual(JSON.parse(deleted!), { deleted: createdId });

  // The effects are the job service's: only the sibling's job remains.
  assert.deepEqual(
    [...store.jobs.values()].map((job) => [job.agentId, job.name]),
    [[siblingId, "Sibling's job"]],
  );
  assert.equal(visible[0]!.text, "Jobs configured.");
});
