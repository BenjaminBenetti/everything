import type { JobSchedulePreview } from "@everything/agent-contracts/job";
import type { AgentCatalog } from "../../agent/interface/agent-catalog.js";
import {
  JobNotFoundError,
  JobSchedulePassedError,
} from "../error/job-errors.js";
import type { JobOperations } from "../interface/job-operations.js";
import type { JobStore } from "../interface/job-repository.js";
import {
  jobLimits,
  type AgentJob,
  type AgentJobChanges,
  type AgentJobDefinition,
  type CreateJobInput,
  type JobOwnerScope,
  type JobRun,
  type JobSchedule,
  type UpdateJobInput,
} from "../model/job.js";
import { jobRunErrors } from "../model/job-dispatch.js";
import {
  firstRunAt,
  normalizeSchedule,
  upcomingRuns,
} from "../model/job-schedule.js";
import { representJob } from "../presenter/job-presenter.js";
import type { JobRuns } from "./job-runs.js";

/** Owner job use cases: the teammate's owner check, schedule policy, and run control. */
export class JobService implements JobOperations {
  // ===========================================
  // Construction
  // ===========================================

  /** Receive teammate ownership, job storage, the dispatcher, and a clock. */
  constructor(
    private readonly agents: Pick<AgentCatalog, "get">,
    private readonly jobs: JobStore,
    private readonly dispatcher: Pick<
      JobRuns,
      "guard" | "dispatch" | "withdraw" | "cancel"
    >,
    private readonly clock: () => Date = () => new Date(),
  ) {}

  // ===========================================
  // Reading
  // ===========================================

  /** Oldest first, each with its latest run. */
  async list(scope: JobOwnerScope): Promise<AgentJob[]> {
    await this.agents.get(scope.ownerId, scope.agentId);
    const jobs = await this.jobs.list(scope);
    const latest = await this.jobs.latestRuns(
      scope,
      jobs.map((job) => job.id),
    );
    return jobs.map((job) => representJob(job, latest.get(job.id) ?? null));
  }

  /** One job found within the owned teammate. */
  async get(scope: JobOwnerScope, id: string): Promise<AgentJob> {
    return this.present(scope, await this.require(scope, id));
  }

  /** Recent runs of a job found within the owned teammate. */
  async runs(scope: JobOwnerScope, id: string): Promise<JobRun[]> {
    await this.require(scope, id);
    return this.jobs.runs(scope, id);
  }

  /** The next few times a schedule would run if saved now. */
  async preview(
    scope: JobOwnerScope,
    schedule: JobSchedule,
  ): Promise<JobSchedulePreview> {
    await this.agents.get(scope.ownerId, scope.agentId);
    const now = this.clock();
    return {
      nextRuns: upcomingRuns(
        normalizeSchedule(schedule, now),
        now,
        jobLimits.previewRuns,
      ).map((run) => run.toISOString()),
    };
  }

  // ===========================================
  // Changes
  // ===========================================

  /** Check the schedule and compute its first due time from now. */
  async create(scope: JobOwnerScope, input: CreateJobInput): Promise<AgentJob> {
    await this.agents.get(scope.ownerId, scope.agentId);
    const now = this.clock();
    const schedule = normalizeSchedule(input.schedule, now);
    const job = await this.jobs.create(scope, {
      name: input.name.trim(),
      instructions: input.instructions.trim(),
      schedule,
      // A checked schedule always has a first time.
      nextRunAt: firstRunAt(schedule, now)!.toISOString(),
      enabled: input.enabled ?? true,
    });
    return representJob(job, null);
  }

  /**
   * Renaming or new instructions keep the next time. A new schedule, or turning the job back on,
   * restarts it from now: an interval's grid is anchored at the save, and missed times aren't run.
   * A finished one-time job can't be turned back on until it has a future time.
   */
  async update(
    scope: JobOwnerScope,
    id: string,
    input: UpdateJobInput,
  ): Promise<AgentJob> {
    return this.dispatcher.guard(id, async () => {
      const job = await this.require(scope, id);
      const now = this.clock();
      const schedule =
        input.schedule && !sameSchedule(input.schedule, job.schedule)
          ? normalizeSchedule(input.schedule, now)
          : undefined;
      const enabled = input.enabled ?? job.enabled;
      let nextRunAt: string | undefined;
      if (schedule || (enabled && !job.enabled)) {
        const first = firstRunAt(schedule ?? job.schedule, now);
        if (first) nextRunAt = first.toISOString();
        else if (enabled) throw new JobSchedulePassedError();
      }
      const changes: AgentJobChanges = {
        ...(input.name === undefined ? {} : { name: input.name.trim() }),
        ...(input.instructions === undefined
          ? {}
          : { instructions: input.instructions.trim() }),
        ...(schedule ? { schedule } : {}),
        ...(nextRunAt ? { nextRunAt } : {}),
        ...(input.enabled === undefined ? {} : { enabled: input.enabled }),
        updatedAt: now.toISOString(),
      };
      const updated = await this.jobs.update(scope, id, changes);
      if (!updated) throw new JobNotFoundError();
      if (job.enabled && !updated.enabled) this.dispatcher.withdraw(id);
      return this.present(scope, updated);
    });
  }

  /** Remove the job and its runs, then stop only its own current run. */
  async delete(scope: JobOwnerScope, id: string): Promise<void> {
    await this.dispatcher.guard(id, async () => {
      await this.require(scope, id);
      await this.jobs.delete(scope, id);
      await this.dispatcher.cancel(id, jobRunErrors.stoppedFromJob);
    });
  }

  /** Record a separate occurrence for now and dispatch it after the record commits. */
  async runNow(scope: JobOwnerScope, id: string): Promise<JobRun> {
    await this.agents.get(scope.ownerId, scope.agentId);
    return this.dispatcher.guard(id, async () => {
      const claimed = await this.jobs.startNow(
        scope,
        id,
        this.clock().toISOString(),
      );
      this.dispatcher.dispatch(claimed);
      return claimed.run;
    });
  }

  /** Stop the current run without pausing; later times still run. */
  async stop(scope: JobOwnerScope, id: string): Promise<void> {
    await this.dispatcher.guard(id, async () => {
      await this.require(scope, id);
      await this.dispatcher.cancel(id, jobRunErrors.stoppedFromJob);
    });
  }

  // ===========================================
  // Helpers
  // ===========================================

  /** Report an unowned teammate as missing, then an unknown job as missing. */
  private async require(
    scope: JobOwnerScope,
    id: string,
  ): Promise<AgentJobDefinition> {
    await this.agents.get(scope.ownerId, scope.agentId);
    const job = await this.jobs.getById(scope, id);
    if (!job) throw new JobNotFoundError();
    return job;
  }

  /** Attach the job's latest run. */
  private async present(
    scope: JobOwnerScope,
    job: AgentJobDefinition,
  ): Promise<AgentJob> {
    const latest = await this.jobs.latestRuns(scope, [job.id]);
    return representJob(job, latest.get(job.id) ?? null);
  }
}

/** Whether a submitted schedule means the saved one, so resubmitting it unchanged isn't a reschedule. */
function sameSchedule(submitted: JobSchedule, saved: JobSchedule): boolean {
  switch (submitted.type) {
    case "once":
      return (
        saved.type === "once" &&
        new Date(submitted.at).getTime() === new Date(saved.at).getTime()
      );
    case "interval":
      return saved.type === "interval" && submitted.seconds === saved.seconds;
    case "cron":
      return (
        saved.type === "cron" &&
        submitted.expression.trim().split(/\s+/).join(" ") ===
          saved.expression &&
        submitted.timezone === saved.timezone
      );
  }
}
