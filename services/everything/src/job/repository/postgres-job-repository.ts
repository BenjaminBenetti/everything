import { randomUUID } from "node:crypto";
import {
  In,
  IsNull,
  LessThanOrEqual,
  Not,
  QueryFailedError,
  type DataSource,
  type EntityManager,
  type FindOptionsWhere,
  type Repository as OrmRepository,
} from "typeorm";
import { BaseRepository } from "@everything/persistence/repository";
import { serializableTransaction } from "@everything/persistence/transaction";
import { AgentNotFoundError } from "../../agent/error/agent-errors.js";
import { AgentEntity } from "../../agent/schema/agent-entity.js";
import {
  JobLimitError,
  JobNotFoundError,
  JobRunActiveError,
} from "../error/job-errors.js";
import type { AgentJobRepository } from "../interface/job-repository.js";
import {
  activeJobRunStatuses,
  jobLimits,
  type AgentJobChanges,
  type AgentJobDefinition,
  type AgentJobRecord,
  type ClaimedJobRun,
  type DueJob,
  type JobAdvance,
  type JobMaintenanceScope,
  type JobOwnerScope,
  type JobRun,
  type JobRunFinish,
  type JobRunRecord,
  type JobScope,
  type NewAgentJob,
} from "../model/job.js";
import { AgentJobEntity } from "../schema/job-entity.js";
import { JobRunEntity } from "../schema/job-run-entity.js";

/** Finished statuses, the only runs pruning may remove. */
const finishedStatuses = ["completed", "failed", "cancelled"] as const;

/** Persist jobs and their runs through ORM relations, with row locks around every claim. */
export class PostgresJobRepository
  extends BaseRepository<AgentJobDefinition, JobScope, AgentJobRecord>
  implements AgentJobRepository
{
  // ===========================================
  // Construction
  // ===========================================

  private readonly runRecords: OrmRepository<JobRunRecord>;

  /** Bind both mapped repositories; job listings are oldest first and bounded by the per-teammate limit. */
  constructor(database: DataSource) {
    super(database.getRepository(AgentJobEntity), {
      order: { createdAt: "ASC", id: "ASC" },
      take: jobLimits.jobsPerTeammate,
    });
    this.runRecords = database.getRepository(JobRunEntity);
  }

  // ===========================================
  // Owner requests
  // ===========================================

  /**
   * Lock the owned teammate so concurrent creations can't pass the limit together. This runs at
   * READ COMMITTED: the row lock serializes a teammate's creations, and each later statement reads
   * after the lock, so the count sees every committed job. Under SERIALIZABLE the snapshot predates
   * the lock wait, so contended creations fail with serialization errors instead of succeeding or
   * reaching the limit.
   */
  async create(
    scope: JobOwnerScope,
    job: NewAgentJob,
  ): Promise<AgentJobDefinition> {
    return this.orm.manager.transaction("READ COMMITTED", async (manager) => {
      const agent = await manager.getRepository(AgentEntity).findOne({
        where: { id: scope.agentId, ownerId: scope.ownerId },
        lock: { mode: "pessimistic_write" },
      });
      if (!agent) throw new AgentNotFoundError();
      const repository = manager.getRepository(AgentJobEntity);
      if (
        (await repository.countBy({ agentId: agent.id })) >=
        jobLimits.jobsPerTeammate
      )
        throw new JobLimitError();
      const { id } = await repository.save(
        repository.create({
          ...job,
          id: randomUUID(),
          agentId: agent.id,
          updatedAt: new Date().toISOString(),
        }),
      );
      // PostgreSQL returns database defaults such as created_at without the column transformers,
      // so read the row back to get the public timestamps.
      return this.toEntity(await repository.findOneByOrFail({ id }));
    });
  }

  /** Change only the supplied fields of a job found within scope. */
  async update(
    scope: JobOwnerScope,
    id: string,
    changes: AgentJobChanges,
  ): Promise<AgentJobDefinition | undefined> {
    return serializableTransaction(this.orm.manager, async (manager) => {
      const repository = manager.getRepository(AgentJobEntity);
      const record = await this.lockJob(manager, {
        ...this.scopeWhere(scope),
        id,
      });
      if (!record) return undefined;
      await repository.update({ id: record.id }, changes);
      return this.toEntity({ ...record, ...changes });
    });
  }

  /** One small indexed lookup per listed job, each still scoped to the owner. */
  async latestRuns(
    scope: JobOwnerScope,
    jobIds: readonly string[],
  ): Promise<Map<string, JobRun>> {
    const latest = await Promise.all(
      jobIds.map((jobId) =>
        this.runRecords.findOne({
          where: { ...this.runScopeWhere(scope), jobId },
          order: { scheduledFor: "DESC" },
        }),
      ),
    );
    return new Map(
      latest.flatMap((record) =>
        record ? [[record.jobId, this.toRun(record)]] : [],
      ),
    );
  }

  /** Newest first, bounded to one listing. */
  async runs(scope: JobOwnerScope, jobId: string): Promise<JobRun[]> {
    const records = await this.runRecords.find({
      where: { ...this.runScopeWhere(scope), jobId },
      order: { scheduledFor: "DESC" },
      take: jobLimits.recentRuns,
    });
    return records.map((record) => this.toRun(record));
  }

  /** Lock the job, refuse overlap, and record the manual occurrence in one transaction. */
  async startNow(
    scope: JobOwnerScope,
    jobId: string,
    at: string,
  ): Promise<ClaimedJobRun> {
    try {
      return await serializableTransaction(
        this.orm.manager,
        async (manager) => {
          const record = await this.lockJob(manager, {
            ...this.scopeWhere(scope),
            id: jobId,
          });
          if (!record) throw new JobNotFoundError();
          if (await this.hasActiveRun(manager, record.id))
            throw new JobRunActiveError();
          const run = await this.insertRun(manager, record.id, at);
          return this.claimed(record, run, true);
        },
      );
    } catch (error) {
      // Another occurrence already holds this exact instant.
      if (isUniqueViolation(error)) throw new JobRunActiveError();
      throw error;
    }
  }

  // ===========================================
  // Scheduler
  // ===========================================

  /** Exclude jobs with an active run first, so long runs can't fill the batch and starve others. */
  async due(
    scope: JobMaintenanceScope,
    now: Date,
    limit: number,
  ): Promise<DueJob[]> {
    const active = await this.runRecords.find({
      select: { jobId: true },
      where: {
        ...this.runScopeWhere(scope),
        status: In([...activeJobRunStatuses]),
      },
    });
    const busy = active.map(({ jobId }) => jobId);
    const records = await this.orm.find({
      select: { id: true, nextRunAt: true },
      where: {
        ...this.scopeWhere(scope),
        enabled: true,
        nextRunAt: LessThanOrEqual(now.toISOString()),
        ...(busy.length ? { id: Not(In(busy)) } : {}),
      },
      order: { nextRunAt: "ASC", id: "ASC" },
      take: limit,
      loadEagerRelations: false,
    });
    return records.map(({ id, nextRunAt }) => ({ id, nextRunAt }));
  }

  /** Recheck, record, and advance under the job's row lock, committing before any dispatch. */
  async claim(
    scope: JobMaintenanceScope,
    id: string,
    now: Date,
    advance: (job: AgentJobDefinition) => JobAdvance,
  ): Promise<ClaimedJobRun | undefined> {
    return serializableTransaction(this.orm.manager, async (manager) => {
      const record = await this.lockJob(manager, {
        ...this.scopeWhere(scope),
        id,
        enabled: true,
        nextRunAt: LessThanOrEqual(now.toISOString()),
      });
      if (!record || (await this.hasActiveRun(manager, id))) return undefined;
      const handled = await manager
        .getRepository(JobRunEntity)
        .existsBy({ jobId: id, scheduledFor: record.nextRunAt });
      const run = handled
        ? undefined
        : await this.insertRun(manager, id, record.nextRunAt);
      const next = advance(this.toEntity(record));
      await manager
        .getRepository(AgentJobEntity)
        .update({ id }, { nextRunAt: next.nextRunAt, enabled: next.enabled });
      // An occurrence recorded earlier is only moved past, never run twice.
      return run && this.claimed(record, run, false);
    });
  }

  /** Nothing from before a restart can still be running, so none of it is replayed or assumed done. */
  async interruptActive(
    scope: JobMaintenanceScope,
    finishedAt: string,
    error: string,
  ): Promise<number> {
    const result = await this.runRecords.update(
      { ...this.runScopeWhere(scope), status: In([...activeJobRunStatuses]) },
      { status: "failed", finishedAt, error },
    );
    return result.affected ?? 0;
  }

  // ===========================================
  // Run lifecycle
  // ===========================================

  /** Only a pending run becomes running. */
  async markRunning(
    scope: JobMaintenanceScope,
    runId: string,
    startedAt: string,
  ): Promise<void> {
    await this.runRecords.update(
      { ...this.runScopeWhere(scope), id: runId, status: "pending" },
      { status: "running", startedAt },
    );
  }

  /** Only an active run finishes, so a late duplicate never overwrites the first ending. */
  async finishRun(
    scope: JobMaintenanceScope,
    runId: string,
    { status, finishedAt, startedAt, error }: JobRunFinish,
  ): Promise<void> {
    await this.runRecords.update(
      {
        ...this.runScopeWhere(scope),
        id: runId,
        status: In([...activeJobRunStatuses]),
      },
      { status, finishedAt, error, ...(startedAt ? { startedAt } : {}) },
    );
  }

  // ===========================================
  // Transaction helpers
  // ===========================================

  /** Read a job and its teammate, holding the job's row lock until the transaction ends. */
  private lockJob(
    manager: EntityManager,
    where: FindOptionsWhere<AgentJobRecord>,
  ): Promise<AgentJobRecord | null> {
    return manager.getRepository(AgentJobEntity).findOne({
      where,
      relations: { agent: true },
      lock: { mode: "pessimistic_write", tables: ["agent_jobs"] },
    });
  }

  /** Whether one of the job's runs is pending or running. */
  private hasActiveRun(
    manager: EntityManager,
    jobId: string,
  ): Promise<boolean> {
    return manager
      .getRepository(JobRunEntity)
      .existsBy({ jobId, status: In([...activeJobRunStatuses]) });
  }

  /** Record a pending occurrence and drop the job's finished runs beyond the retained history. */
  private async insertRun(
    manager: EntityManager,
    jobId: string,
    scheduledFor: string,
  ): Promise<JobRun> {
    const repository = manager.getRepository(JobRunEntity);
    const record = await repository.save(
      repository.create({
        id: randomUUID(),
        jobId,
        scheduledFor,
        status: "pending",
        startedAt: null,
        finishedAt: null,
        error: null,
      }),
    );
    const [cutoff] = await repository.find({
      select: { id: true, scheduledFor: true },
      where: { jobId },
      order: { scheduledFor: "DESC" },
      skip: jobLimits.retainedRuns,
      take: 1,
    });
    if (cutoff)
      await repository.delete({
        jobId,
        scheduledFor: LessThanOrEqual(cutoff.scheduledFor),
        status: In([...finishedStatuses]),
      });
    return this.toRun(record);
  }

  /** The run with what the dispatcher needs from its job, read under the same lock. */
  private claimed(
    record: AgentJobRecord,
    run: JobRun,
    manual: boolean,
  ): ClaimedJobRun {
    return {
      run,
      ownerId: record.agent!.ownerId,
      job: {
        id: record.id,
        agentId: record.agentId,
        name: record.name,
        instructions: record.instructions,
        schedule: record.schedule,
      },
      manual,
    };
  }

  // ===========================================
  // Domain policy
  // ===========================================

  /** Owner requests are limited to one owned teammate; maintenance must name its scope explicitly. */
  protected scopeWhere(scope: JobScope): FindOptionsWhere<AgentJobRecord> {
    if ("ownership" in scope) {
      if (scope.ownership !== "all")
        throw new Error("Job maintenance requires an explicit ownership scope");
      return { agentId: Not(IsNull()) };
    }
    return { agentId: scope.agentId, agent: { ownerId: scope.ownerId } };
  }

  /** Runs inherit their job's scope through the job relation. */
  private runScopeWhere(scope: JobScope): FindOptionsWhere<JobRunRecord> {
    if ("ownership" in scope) {
      if (scope.ownership !== "all")
        throw new Error("Job maintenance requires an explicit ownership scope");
      return { jobId: Not(IsNull()) };
    }
    return {
      job: { agentId: scope.agentId, agent: { ownerId: scope.ownerId } },
    };
  }

  /** Exclude the teammate relation from the domain projection. */
  protected toEntity({
    id,
    agentId,
    name,
    instructions,
    schedule,
    nextRunAt,
    enabled,
    createdAt,
    updatedAt,
  }: AgentJobRecord): AgentJobDefinition {
    return {
      id,
      agentId,
      name,
      instructions,
      schedule,
      nextRunAt,
      enabled,
      createdAt,
      updatedAt,
    };
  }

  /** Exclude the job relation from a run. */
  private toRun({
    id,
    jobId,
    scheduledFor,
    status,
    startedAt,
    finishedAt,
    error,
  }: JobRunRecord): JobRun {
    return { id, jobId, scheduledFor, status, startedAt, finishedAt, error };
  }
}

/** PostgreSQL's unique-violation code. */
function isUniqueViolation(error: unknown): boolean {
  return (
    error instanceof QueryFailedError &&
    (error.driverError as { code?: string }).code === "23505"
  );
}
