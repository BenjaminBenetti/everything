import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { mkdir, writeFile } from "node:fs/promises";
import path from "node:path";
import { setTimeout as delay } from "node:timers/promises";
import { ApiDocumentationService } from "../../api-documentation/service/api-documentation-service.js";
import {
  createHttpApplication,
  type HttpDependencies,
} from "../../application/factory/http-application.js";
import { AgentNotFoundError } from "../../agent/error/agent-errors.js";
import type { AgentCatalog } from "../../agent/interface/agent-catalog.js";
import type { AgentDefinition } from "../../agent/model/agent.js";
import type { ConversationMessageStore } from "../../conversation/interface/message-repository.js";
import type { ConversationMessage } from "../../conversation/model/message.js";
import { ConversationService } from "../../conversation/service/conversation-service.js";
import type { AgentSessionFactory } from "../../runtime/interface/agent-session.js";
import type { ForkableSession } from "../../runtime/interface/session-forks.js";
import { ForkingAgentSession } from "../../runtime/service/forking-agent-session.js";
import { SubagentService } from "../../subagent/service/subagent-service.js";
import { jobRunErrors } from "../model/job-dispatch.js";
import { JobRuns } from "../service/job-runs.js";
import { JobScheduler } from "../service/job-scheduler.js";
import { JobService } from "../service/job-service.js";
import { MemoryJobs } from "./job-fixtures.js";

/** The teammate the browser test opens. */
export const e2eAgentId = "5d0c6a52-8b8e-4c55-9c1a-3f1d2e7b9a10";
const ownerId = "jobs-e2e-owner";

/** Every operation the chat page doesn't use through this gateway fails loudly. */
function unused<T>(): T {
  return new Proxy(
    {},
    {
      get: (_target, property) => () =>
        assert.fail(`Unused: ${String(property)}`),
    },
  ) as T;
}

/** A mocked model session: each turn waits `turnMs` (abortably), then answers with `respond`. */
function mockedSession(
  id: string,
  turnMs: number,
  respond: (input: string) => Promise<string | undefined>,
): ForkableSession {
  let last: string | undefined;
  let turn: AbortController | undefined;
  return {
    id,
    compacting: false,
    compactionStartedAt: null,
    typing: false,
    lastToolName: "send_message",
    get lastResponse() {
      return last;
    },
    async prompt(input) {
      turn = new AbortController();
      const { signal } = turn;
      await delay(turnMs, undefined, { signal }).catch(() => {});
      if (!signal.aborted) last = await respond(input);
    },
    async abort() {
      turn?.abort();
    },
    async dispose() {
      turn?.abort();
    },
  };
}

/**
 * Real HTTP, job, scheduler, dispatcher, conversation, subagent, and session-family code. Synthetic:
 * sign-in, in-memory records instead of PostgreSQL, the model, and a clock the test advances.
 */
export async function createJobGateway(
  root: string,
  origin: string,
  { turnMs = 4_000 }: { turnMs?: number } = {},
) {
  const evidence = path.join(root, "evidence");
  await mkdir(evidence, { recursive: true });
  // Real time, moved ahead whenever the test skips to a due time.
  let skipped = 0;
  const clock = { now: () => new Date(Date.now() + skipped) };

  const teammate: AgentDefinition = {
    id: e2eAgentId,
    ownerId,
    name: "Avery",
    systemPrompt: "Keep an eye on the project.",
    avatarId: "avatar-03",
    inference: { provider: "anthropic", model: "mocked-model", effort: "high" },
    createdAt: "2026-10-30T09:00:00.000Z",
  };
  const agents: Pick<AgentCatalog, "get" | "delete"> = {
    async get(owner, id) {
      if (owner !== ownerId || id !== e2eAgentId)
        throw new AgentNotFoundError();
      return teammate;
    },
    async delete() {
      assert.fail("Teammates are not deleted in this test");
    },
  };

  const messages: ConversationMessage[] = [];
  const store: ConversationMessageStore = {
    async append(_scope, role, text) {
      const message: ConversationMessage = {
        id: randomUUID(),
        role,
        text,
        createdAt: new Date().toISOString(),
        attachments: [],
      };
      messages.push(message);
      return message;
    },
    async deliver(_scope, text) {
      return this.append(_scope, "assistant", text, []);
    },
    async page() {
      return { messages: messages.slice(-100), nextCursor: null };
    },
  };

  // The mocked model. Background sessions record their task and answer after a delay; main records
  // what woke it and messages the user, as a teammate would after a job's result reaches it.
  let backgroundTurns = 0;
  let mainTurns = 0;
  const sessions: AgentSessionFactory = {
    async create(_agent, sendMessage) {
      const main = mockedSession("main", 300, async (input) => {
        mainTurns++;
        await writeFile(
          path.join(evidence, `main-input-${mainTurns}.txt`),
          input,
        );
        if (/^Fork [0-9a-f-]+ finished:/.test(input))
          await sendMessage(
            "(Mocked model reply.) Release watch ran in the background: no new release since yesterday, so nothing needs your attention.",
          );
        return undefined;
      });
      return new ForkingAgentSession(
        main,
        {
          async create() {
            return mockedSession(randomUUID(), turnMs, async (input) => {
              backgroundTurns++;
              await writeFile(
                path.join(evidence, `background-task-${backgroundTurns}.txt`),
                input,
              );
              return "(Mocked background reply.) Checked the releases page: no new release since yesterday.";
            });
          },
        },
        undefined,
        {
          messages: () => ({ messages: [], nextCursor: null }),
          remove: async () => {},
        },
      );
    },
  };
  const conversations = new ConversationService(agents, store, sessions, {
    async remove() {},
  });
  const subagents = new SubagentService(conversations, {
    open: async () => assert.fail("Archives are not used in this test"),
  });

  // The real job stack over in-memory records that apply the PostgreSQL repository's rules.
  const jobsStore = new MemoryJobs(clock.now, { [e2eAgentId]: ownerId });
  const failures: string[] = [];
  const runs = new JobRuns(
    subagents,
    jobsStore,
    () => failures.push("run"),
    undefined,
    clock.now,
  );
  const scheduler = new JobScheduler(
    jobsStore,
    runs,
    () => failures.push("scheduler"),
    clock.now,
  );
  const jobs = new JobService(agents, jobsStore, runs, clock.now);
  const scope = { ownerId, agentId: e2eAgentId };

  // Synthetic jobs for the list: a weekday cron job and a nightly job with earlier runs.
  await jobs.create(scope, {
    name: "Weekday PR check",
    instructions:
      "Each weekday morning, list open pull requests waiting for my review and tell me only if one is older than two days.",
    schedule: {
      type: "cron",
      expression: "0 9 * * 1-5",
      timezone: "Europe/Paris",
    },
  });
  const nightly = await jobs.create(scope, {
    name: "Nightly backup check",
    instructions:
      "Check that last night's backup finished and tell me if it didn't.",
    schedule: { type: "interval", seconds: 86_400 },
  });
  const day = 86_400_000;
  const now = clock.now().getTime();
  for (const [offset, status, error] of [
    [2 * day, "completed", null],
    [
      day,
      "failed",
      "Didn't start because this teammate's model provider isn't connected. Reconnect it in Model providers.",
    ],
  ] as const)
    jobsStore.runRecords.push({
      id: randomUUID(),
      jobId: nightly.id,
      scheduledFor: new Date(now - offset).toISOString(),
      status,
      startedAt:
        status === "completed"
          ? new Date(now - offset + 2_000).toISOString()
          : null,
      finishedAt: new Date(now - offset + 40_000).toISOString(),
      error,
    });

  const dependencies: HttpDependencies = {
    apiDocumentation: new ApiDocumentationService(),
    verifier: {
      verify: async (token) => {
        if (token !== "jobs-e2e-token") throw new Error("invalid");
        return { subject: ownerId };
      },
    },
    sessions: {
      ...unused<HttpDependencies["sessions"]>(),
      resolve: async (handle) =>
        handle === "jobs-e2e-session"
          ? {
              accessToken: "jobs-e2e-token",
              profile: { subject: ownerId, displayName: "Jobs tester" },
            }
          : undefined,
    },
    publicOrigin: origin,
    chatGptRedirectUri: "http://127.0.0.1:8080/v1/providers/chatgpt/callback",
    keys: unused(),
    credentialGrants: unused(),
    credentialRollouts: unused(),
    providers: unused(),
    models: unused(),
    agents: unused(),
    agentActivity: unused(),
    profiles: unused(),
    removal: unused(),
    conversations,
    attachments: unused(),
    subagents,
    jobs,
    updates: unused(),
    upgrades: unused(),
    artifacts: unused(),
    workers: unused(),
    generalSettings: unused(),
    teammateOrder: unused(),
    workspaces: unused(),
    workspaceActivity: unused(),
    voice: unused(),
    voiceStreams: unused(),
    telemetry: unused(),
    readiness: async () => {},
  };
  const app = await createHttpApplication(dependencies);

  // Test-only controls outside the authenticated API: move the job clock and run one scheduler check,
  // and read what the mocked model received.
  app.post<{ Querystring: { ms: string } }>("/e2e/advance", async (request) => {
    skipped += Number(request.query.ms);
    await scheduler.refresh();
    return { now: clock.now().toISOString() };
  });
  app.get("/e2e/state", async () => ({
    now: clock.now().toISOString(),
    failures,
    runs: jobsStore.runRecords,
    jobs: [...jobsStore.jobs.values()],
    backgroundTurns,
    mainTurns,
    stoppedReason: jobRunErrors.stoppedFromJob,
  }));
  app.addHook("onClose", async () => {
    await scheduler.close();
    await runs.close();
    await conversations.close();
    await runs.settled();
  });
  return { app, scheduler, evidence };
}
