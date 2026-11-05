import assert from "node:assert/strict";
import { test } from "node:test";
import {
  toToolDeclaration,
  validateToolArguments,
} from "@earendil-works/pi-ai";
import { AgentNotFoundError } from "../../agent/error/agent-errors.js";
import {
  JobLimitError,
  JobNotFoundError,
  JobScheduleError,
  JobSchedulePassedError,
} from "../error/job-errors.js";
import { jobLimits } from "../model/job.js";
import { JobRuns } from "../service/job-runs.js";
import { JobService } from "../service/job-service.js";
import { jobTools, jobToolNames } from "../tool/job-tools.js";
import {
  FakeClock,
  FakeWakeups,
  fixtureAgents,
  MemoryJobs,
  settle,
  teammates,
} from "./job-fixtures.js";

const avery = { ownerId: "owner", agentId: teammates.avery } as const;
const weekdays = {
  type: "cron",
  expression: "0 9 * * 1-5",
  timezone: "Europe/Paris",
} as const;

type JobTool = ReturnType<typeof jobTools>[number];

/** The real job service over in-memory storage, and the tools bound to Avery. */
function fixture() {
  const clock = new FakeClock("2026-11-05T10:00:00.000Z");
  const store = new MemoryJobs(clock.now);
  const wakeups = new FakeWakeups();
  const runs = new JobRuns(
    wakeups,
    store,
    () => {},
    { retries: 0, minRetryMs: 0, maxRetryMs: 0 },
    clock.now,
  );
  const service = new JobService(fixtureAgents(), store, runs, clock.now);
  const tools = jobTools(service, avery);
  const tool = (name: string) => tools.find((item) => item.name === name)!;
  return { clock, store, wakeups, runs, service, tools, tool };
}

/** Validate arguments as Pi does for every model tool call, then execute and parse the result. */
async function call(tool: JobTool, args: unknown): Promise<any> {
  const validated = validateToolArguments(
    tool as never,
    {
      type: "toolCall",
      id: "call",
      name: tool.name,
      arguments: args,
    } as never,
  );
  const output = await tool.execute(
    "call",
    validated as never,
    undefined,
    undefined,
    {} as never,
  );
  const [content] = output.content as { type: "text"; text: string }[];
  return JSON.parse(content!.text);
}

/** Whether Pi refuses the arguments before the tool runs. */
function refused(tool: JobTool, args: unknown): boolean {
  try {
    validateToolArguments(
      tool as never,
      {
        type: "toolCall",
        id: "call",
        name: tool.name,
        arguments: args,
      } as never,
    );
    return false;
  } catch (error) {
    return /Validation failed/.test((error as Error).message);
  }
}

test("exactly four tools declare their own arguments to the provider, with no owner or teammate selector", () => {
  const { tools } = fixture();
  assert.deepEqual(
    tools.map((tool) => tool.name),
    ["create_job", "list_jobs", "update_job", "delete_job"],
  );
  const declarations = Object.fromEntries(
    tools.map((tool) => {
      const declaration = toToolDeclaration(tool as never);
      return [declaration.name, declaration];
    }),
  );
  const parameters = (name: string) =>
    declarations[name]!.parameters as {
      properties: Record<string, unknown>;
      required?: string[];
      additionalProperties: boolean;
      minProperties?: number;
    };
  assert.deepEqual(Object.keys(parameters("create_job").properties), [
    "name",
    "instructions",
    "schedule",
    "enabled",
  ]);
  assert.deepEqual([...parameters("create_job").required!].sort(), [
    "instructions",
    "name",
    "schedule",
  ]);
  assert.deepEqual(Object.keys(parameters("list_jobs").properties), []);
  assert.deepEqual(Object.keys(parameters("update_job").properties), [
    "id",
    "name",
    "instructions",
    "schedule",
    "enabled",
  ]);
  assert.deepEqual(parameters("update_job").required, ["id"]);
  assert.equal(parameters("update_job").minProperties, 2);
  assert.deepEqual(Object.keys(parameters("delete_job").properties), ["id"]);
  for (const name of Object.values(jobToolNames)) {
    assert.equal(parameters(name).additionalProperties, false, name);
    assert.doesNotMatch(
      JSON.stringify(Object.keys(parameters(name).properties)),
      /owner|agent/i,
    );
  }
  assert.match(declarations.create_job!.description, /explicitly asks/);
  assert.match(declarations.create_job!.description, /don't guess/);
  assert.match(declarations.update_job!.description, /enabled: false pauses/);
});

test("Pi refuses arguments outside each schema, including smuggled owner or teammate IDs", () => {
  const { tool, store } = fixture();
  const base = { name: "Check", instructions: "Check it.", schedule: weekdays };
  const id = "6f1c1f6e-8c7e-4c4b-9a43-2d8b8f7c8f11";
  for (const [name, args] of [
    ["create_job", { ...base, agent_id: teammates.blake }],
    ["create_job", { ...base, ownerId: "other" }],
    ["create_job", { name: "Check", instructions: "Check it." }],
    ["create_job", { ...base, name: "   " }],
    ["create_job", { ...base, schedule: { type: "interval", seconds: 60 } }],
    ["create_job", { ...base, schedule: { type: "rrule", rule: "DAILY" } }],
    ["create_job", { ...base, schedule: { ...weekdays, jitter: 5 } }],
    ["create_job", { ...base, schedule: { type: "once", at: "tomorrow" } }],
    ["list_jobs", { agentId: teammates.blake }],
    ["update_job", { id }],
    ["update_job", { id: "not-a-uuid", enabled: false }],
    ["update_job", { id, enabled: false, agentId: teammates.blake }],
    ["update_job", { id, nextRunAt: "2026-11-05T11:00:00Z" }],
    ["update_job", { id, status: "completed" }],
    ["delete_job", { id, agent_id: teammates.blake }],
    ["delete_job", {}],
  ] as const)
    assert.ok(refused(tool(name), args), `${name} ${JSON.stringify(args)}`);
  assert.equal(store.jobs.size, 0);
});

test("create, list, pause, resume, and delete act on the bound teammate through the job service", async () => {
  const { tool, store, clock } = fixture();
  const created = await call(tool("create_job"), {
    name: "Morning PRs",
    instructions: "List open pull requests waiting for my review.",
    schedule: weekdays,
  });
  assert.deepEqual(
    { ...created, id: undefined },
    {
      id: undefined,
      name: "Morning PRs",
      instructions: "List open pull requests waiting for my review.",
      schedule: weekdays,
      enabled: true,
      nextRunAt: "2026-11-06T08:00:00.000Z",
      latestRun: null,
    },
  );
  assert.equal(store.jobs.get(created.id)!.agentId, teammates.avery);

  const listed = await call(tool("list_jobs"), {});
  assert.deepEqual(
    listed.jobs.map((job: { id: string }) => job.id),
    [created.id],
  );

  const paused = await call(tool("update_job"), {
    id: created.id,
    enabled: false,
  });
  assert.equal(paused.enabled, false);
  assert.equal(paused.nextRunAt, null);
  clock.advance(24 * 60 * 60_000);
  const resumed = await call(tool("update_job"), {
    id: created.id,
    enabled: true,
  });
  // Resuming restarts from now: Friday at 11:00 in Paris, so the next weekday 9:00 is Monday.
  assert.equal(resumed.nextRunAt, "2026-11-09T08:00:00.000Z");
  const renamed = await call(tool("update_job"), {
    id: created.id,
    name: "PR check",
    schedule: { type: "interval", seconds: 900 },
  });
  assert.equal(renamed.name, "PR check");
  assert.equal(renamed.nextRunAt, "2026-11-06T10:15:00.000Z");

  assert.deepEqual(await call(tool("delete_job"), { id: created.id }), {
    deleted: created.id,
  });
  assert.equal(store.jobs.size, 0);
});

test("other teammates' and owners' jobs look missing, and the job service's refusals reach the model", async () => {
  const { tool, service, store, clock } = fixture();
  const blakes = await service.create(
    { ownerId: "owner", agentId: teammates.blake },
    { name: "Blake's", instructions: "Check.", schedule: weekdays },
  );
  await assert.rejects(
    call(tool("update_job"), { id: blakes.id, name: "Taken" }),
    JobNotFoundError,
  );
  await assert.rejects(
    call(tool("delete_job"), { id: blakes.id }),
    JobNotFoundError,
  );
  assert.equal(store.jobs.get(blakes.id)!.name, "Blake's");
  assert.deepEqual((await call(tool("list_jobs"), {})).jobs, []);

  // Tools bound to a teammate the owner doesn't have see nothing at all.
  const foreign = jobTools(service, {
    ownerId: "owner",
    agentId: teammates.foreign,
  });
  await assert.rejects(call(foreign[1]!, {}), AgentNotFoundError);

  const base = { name: "Check", instructions: "Check it." };
  for (const [schedule, message] of [
    [{ ...weekdays, timezone: "Mars/Olympus" }, /IANA/],
    [{ ...weekdays, expression: "*/2 * * * *" }, /five minutes apart/],
    [{ type: "once", at: "2026-11-05T09:00:00Z" }, /future/],
  ] as const)
    await assert.rejects(
      call(tool("create_job"), { ...base, schedule }),
      (error: unknown) =>
        error instanceof JobScheduleError && message.test(error.message),
    );

  const once = await call(tool("create_job"), {
    ...base,
    schedule: { type: "once", at: "2026-11-05T10:30:00Z" },
    enabled: false,
  });
  assert.equal(once.enabled, false);
  clock.advance(60 * 60_000);
  await assert.rejects(
    call(tool("update_job"), { id: once.id, enabled: true }),
    JobSchedulePassedError,
  );

  const long = await call(tool("create_job"), {
    ...base,
    instructions: "x".repeat(jobLimits.instructionsLength),
    schedule: { type: "interval", seconds: 3600 },
  });
  const listing = await call(tool("list_jobs"), {});
  const listed = listing.jobs.find((job: { id: string }) => job.id === long.id);
  assert.equal(listed.instructions.length, 501);
  assert.equal(listed.instructionsShortened, true);
  assert.ok(!JSON.stringify(listing).includes(teammates.avery));

  for (let index = 2; index < jobLimits.jobsPerTeammate; index++)
    await call(tool("create_job"), {
      ...base,
      schedule: { type: "interval", seconds: 3600 },
    });
  await assert.rejects(
    call(tool("create_job"), { ...base, schedule: weekdays }),
    JobLimitError,
  );
});

test("deleting through the tool stops only that job's current run", async () => {
  const { tool, service, wakeups, runs } = fixture();
  const build = await call(tool("create_job"), {
    name: "Build",
    instructions: "Check the build.",
    schedule: weekdays,
  });
  const inbox = await call(tool("create_job"), {
    name: "Inbox",
    instructions: "Check the inbox.",
    schedule: weekdays,
  });
  await service.runNow(avery, build.id);
  await service.runNow(avery, inbox.id);
  await settle();
  const [buildRun, inboxRun] = wakeups.accepted;
  await call(tool("delete_job"), { id: build.id });
  await runs.settled();
  assert.deepEqual(wakeups.deleted, [buildRun!.id]);
  const remaining = await call(tool("list_jobs"), {});
  assert.deepEqual(
    remaining.jobs.map((job: { id: string; latestRun: { status: string } }) => [
      job.id,
      job.latestRun.status,
    ]),
    [[inbox.id, "running"]],
  );
  assert.ok(inboxRun);
});
