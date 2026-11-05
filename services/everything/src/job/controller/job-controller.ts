import type { FastifyInstance } from "fastify";
import { subject } from "@everything/security/fastify";
import {
  agentParams,
  type AgentParams,
} from "../../agent/schema/agent-request.js";
import { noContentResponse } from "../../http/schema/http-response.js";
import type { JobOperations } from "../interface/job-operations.js";
import {
  createJobBody,
  jobParams,
  jobPreviewBody,
  updateJobBody,
  type CreateJobBody,
  type JobParams,
  type JobPreviewBody,
  type UpdateJobBody,
} from "../schema/job-request.js";
import {
  jobListResponse,
  jobPreviewResponse,
  jobResponse,
  jobRunListResponse,
  jobRunResponse,
} from "../schema/job-response.js";

/** Expose a teammate's scheduled jobs and their run history to its authenticated owner. */
export async function jobController(
  app: FastifyInstance,
  jobs: JobOperations,
): Promise<void> {
  const collection = "/agents/:agentId/jobs";
  const item = `${collection}/:jobId`;
  app.get<{ Params: AgentParams }>(
    collection,
    {
      schema: {
        summary: "List a teammate's scheduled jobs",
        description:
          "Oldest first, each with its most recent run. A paused job has nextRunAt null.",
        params: agentParams,
        response: { 200: jobListResponse },
      },
    },
    async (request) => ({
      jobs: await jobs.list({
        ownerId: subject(request),
        agentId: request.params.agentId,
      }),
    }),
  );
  app.post<{ Params: AgentParams; Body: CreateJobBody }>(
    collection,
    {
      schema: {
        summary: "Create a scheduled job",
        description:
          "Each run wakes a temporary private background session with fresh context and these instructions, through the same path as subagent wakeups; its final reply goes to main, which decides whether to tell the user. Saving a job authorizes its scheduled runs, with the teammate's normal tools and permissions. Interval jobs first run one interval after saving; cron uses the given IANA timezone, including its daylight saving changes. Runs and cron matches must be at least five minutes apart, and a teammate can have 25 jobs.",
        params: agentParams,
        body: createJobBody,
        response: { 201: jobResponse },
      },
    },
    async (request, reply) =>
      reply
        .code(201)
        .send(
          await jobs.create(
            { ownerId: subject(request), agentId: request.params.agentId },
            request.body,
          ),
        ),
  );
  app.post<{ Params: AgentParams; Body: JobPreviewBody }>(
    `${collection}/preview`,
    {
      schema: {
        summary: "Preview a job schedule",
        description:
          "Checks a schedule as creating a job would and returns its next three times, without saving.",
        params: agentParams,
        body: jobPreviewBody,
        response: { 200: jobPreviewResponse },
      },
    },
    async (request) =>
      jobs.preview(
        { ownerId: subject(request), agentId: request.params.agentId },
        request.body.schedule,
      ),
  );
  app.get<{ Params: JobParams }>(
    item,
    {
      schema: {
        summary: "Read a scheduled job",
        params: jobParams,
        response: { 200: jobResponse },
      },
    },
    async (request) =>
      jobs.get(
        { ownerId: subject(request), agentId: request.params.agentId },
        request.params.jobId,
      ),
  );
  app.patch<{ Params: JobParams; Body: UpdateJobBody }>(
    item,
    {
      schema: {
        summary: "Change a scheduled job",
        description:
          "Renaming or new instructions keep the next time. A new schedule, or enabled true after a pause, restarts timing from now without running missed times; a one-time job whose time has passed needs a future time first (409). enabled false pauses future runs and withdraws a run not yet accepted; it doesn't stop a running one.",
        params: jobParams,
        body: updateJobBody,
        response: { 200: jobResponse },
      },
    },
    async (request) =>
      jobs.update(
        { ownerId: subject(request), agentId: request.params.agentId },
        request.params.jobId,
        request.body,
      ),
  );
  app.delete<{ Params: JobParams }>(
    item,
    {
      schema: {
        summary: "Delete a scheduled job",
        description:
          "Removes the job and its run history, and stops only this job's current run. Messages already delivered to main remain.",
        params: jobParams,
        response: { 204: noContentResponse },
      },
    },
    async (request, reply) => {
      await jobs.delete(
        { ownerId: subject(request), agentId: request.params.agentId },
        request.params.jobId,
      );
      return reply.code(204).send();
    },
  );
  app.get<{ Params: JobParams }>(
    `${item}/runs`,
    {
      schema: {
        summary: "List a job's recent runs",
        description:
          "The latest 20 runs, newest first: operational status, times, and safe errors only, never what the teammate found. A run is completed when its temporary session's last turn ended normally.",
        params: jobParams,
        response: { 200: jobRunListResponse },
      },
    },
    async (request) => ({
      runs: await jobs.runs(
        { ownerId: subject(request), agentId: request.params.agentId },
        request.params.jobId,
      ),
    }),
  );
  app.post<{ Params: JobParams }>(
    `${item}/runs`,
    {
      schema: {
        summary: "Run a job now",
        description:
          "Records a separate run for the current time and returns it pending, before the teammate accepts it; works while the job is paused and doesn't change its schedule. Returns 409 while another run of the job is pending or running.",
        params: jobParams,
        response: { 202: jobRunResponse },
      },
    },
    async (request, reply) =>
      reply
        .code(202)
        .send(
          await jobs.runNow(
            { ownerId: subject(request), agentId: request.params.agentId },
            request.params.jobId,
          ),
        ),
  );
  app.post<{ Params: JobParams }>(
    `${item}/stop`,
    {
      schema: {
        summary: "Stop a job's current run",
        description:
          "Cancels this job's pending or running run and removes only its background session; the teammate's other work continues. The job stays on its schedule; pause it to prevent later runs.",
        params: jobParams,
        response: { 204: noContentResponse },
      },
    },
    async (request, reply) => {
      await jobs.stop(
        { ownerId: subject(request), agentId: request.params.agentId },
        request.params.jobId,
      );
      return reply.code(204).send();
    },
  );
}
