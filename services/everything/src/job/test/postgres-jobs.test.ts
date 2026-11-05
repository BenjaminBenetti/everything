import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { test } from "node:test";
import pg from "pg";
import { QueryFailedError, type DataSource } from "typeorm";
import { AgentEntity } from "../../agent/schema/agent-entity.js";
import { createApplicationDatabase } from "../../persistence/factory/application-database.js";
import { JobLimitError, JobRunActiveError } from "../error/job-errors.js";
import { allJobs, jobLimits, type NewAgentJob } from "../model/job.js";
import { advanceAfterClaim } from "../model/job-schedule.js";
import { PostgresJobRepository } from "../repository/postgres-job-repository.js";

/** An explicitly supplied test server; each run creates and removes only its own random database. */
const serverUrl = process.env.JOBS_TEST_DATABASE_URL;

// CI requires this test to run against its isolated database, so a missing server fails instead of skipping.
if (process.env.JOBS_TEST_DATABASE_REQUIRED === "1" && !serverUrl)
  throw new Error(
    "JOBS_TEST_DATABASE_REQUIRED is set, but JOBS_TEST_DATABASE_URL names no server",
  );

/** Schema statements TypeORM would run to match the entities; empty when migrations mirror them. */
async function drift(database: DataSource): Promise<string[]> {
  const log = await database.driver.createSchemaBuilder().log();
  return log.upQueries.map((query) => query.query);
}

/** The PostgreSQL error code a statement failed with. */
async function failure(statement: Promise<unknown>): Promise<string> {
  try {
    await statement;
  } catch (error) {
    assert.ok(error instanceof QueryFailedError);
    return (error.driverError as { code: string }).code;
  }
  assert.fail("expected the statement to fail");
}

test(
  "PostgreSQL job migration, constraints, scope, claims, overlap, pruning, recovery, and cascades",
  { skip: !serverUrl },
  async () => {
    const admin = new pg.Client({ connectionString: serverUrl });
    await admin.connect();
    const name = `jobs_test_${randomUUID().replaceAll("-", "")}`;
    await admin.query(`CREATE DATABASE "${name}"`);
    const address = new URL(serverUrl!);
    address.pathname = `/${name}`;
    const database = createApplicationDatabase({
      databaseUrl: address.href,
      databasePassword: decodeURIComponent(address.password),
    });
    try {
      await database.initialize();
      await database.runMigrations();
      assert.deepEqual(await drift(database), []);
      // The migration creates exactly the approved columns, and no jobs.
      const columns = async (table: string) =>
        (
          (await database.query(
            "SELECT column_name FROM information_schema.columns WHERE table_name = $1 ORDER BY ordinal_position",
            [table],
          )) as { column_name: string }[]
        ).map((row) => row.column_name);
      assert.deepEqual(await columns("agent_jobs"), [
        "id",
        "agent_id",
        "name",
        "instructions",
        "schedule",
        "next_run_at",
        "enabled",
        "created_at",
        "updated_at",
      ]);
      assert.deepEqual(await columns("agent_job_runs"), [
        "id",
        "job_id",
        "scheduled_for",
        "status",
        "started_at",
        "finished_at",
        "error",
      ]);
      assert.deepEqual(
        await database.query("SELECT count(*)::int AS count FROM agent_jobs"),
        [{ count: 0 }],
      );

      const avery = randomUUID();
      const blake = randomUUID();
      const foreign = randomUUID();
      for (const [id, ownerId] of [
        [avery, "owner"],
        [blake, "owner"],
        [foreign, "other"],
      ] as const)
        await database.getRepository(AgentEntity).save({
          id,
          ownerId,
          name: "Avery",
          systemPrompt: "Help",
          avatarId: "avatar-03",
          inference: null,
        });
      const jobs = new PostgresJobRepository(database);
      const scope = { ownerId: "owner", agentId: avery };
      const job = (overrides: Partial<NewAgentJob> = {}): NewAgentJob => ({
        name: "Check the build",
        instructions: "Look at CI.",
        schedule: { type: "interval", seconds: 300 },
        nextRunAt: "2026-11-05T10:05:00.000Z",
        enabled: true,
        ...overrides,
      });

      // Owner scope through the teammate.
      const build = await jobs.create(scope, job());
      assert.deepEqual(await jobs.list(scope), [build]);
      assert.equal(
        await jobs.getById({ ownerId: "other", agentId: avery }, build.id),
        undefined,
      );
      assert.equal(
        await jobs.getById({ ownerId: "owner", agentId: blake }, build.id),
        undefined,
      );
      assert.equal(
        await jobs.update({ ownerId: "other", agentId: avery }, build.id, {
          name: "Taken",
          updatedAt: new Date().toISOString(),
        }),
        undefined,
      );
      await jobs.delete({ ownerId: "owner", agentId: blake }, build.id);
      assert.ok(await jobs.getById(scope, build.id));
      await assert.rejects(
        jobs.create({ ownerId: "owner", agentId: foreign }, job()),
        { code: "AGENT_NOT_FOUND" },
      );
      const renamed = await jobs.update(scope, build.id, {
        name: "Build",
        schedule: {
          type: "cron",
          expression: "0 9 * * 1-5",
          timezone: "Europe/Paris",
        },
        updatedAt: "2026-11-05T10:01:00.000Z",
      });
      assert.equal(renamed?.name, "Build");
      assert.deepEqual((await jobs.getById(scope, build.id))?.schedule, {
        type: "cron",
        expression: "0 9 * * 1-5",
        timezone: "Europe/Paris",
      });
      await jobs.update(scope, build.id, {
        schedule: { type: "interval", seconds: 300 },
        updatedAt: "2026-11-05T10:01:00.000Z",
      });

      // Concurrent claims of one due occurrence record one run and advance the job once.
      const now = new Date("2026-11-05T10:05:02.000Z");
      const claims = await Promise.all(
        Array.from({ length: 5 }, () =>
          jobs.claim(allJobs, build.id, now, (target) =>
            advanceAfterClaim(target, now),
          ),
        ),
      );
      const claimed = claims.filter((item) => item !== undefined);
      assert.equal(claimed.length, 1);
      assert.equal(claimed[0]!.ownerId, "owner");
      assert.equal(claimed[0]!.run.scheduledFor, "2026-11-05T10:05:00.000Z");
      assert.equal(
        (await jobs.getById(scope, build.id))?.nextRunAt,
        "2026-11-05T10:10:00.000Z",
      );
      // A busy job isn't due, and starting it manually is refused while its run is active.
      const later = new Date("2026-11-05T11:00:00.000Z");
      assert.deepEqual(await jobs.due(allJobs, later, 20), []);
      await assert.rejects(
        jobs.startNow(scope, build.id, later.toISOString()),
        JobRunActiveError,
      );
      // Both unique rules hold in the database itself.
      const runId = claimed[0]!.run.id;
      assert.equal(
        await failure(
          database.query(
            "INSERT INTO agent_job_runs (id, job_id, scheduled_for, status) VALUES ($1, $2, $3, 'pending')",
            [randomUUID(), build.id, "2026-11-05T12:00:00Z"],
          ),
        ),
        "23505",
      );
      assert.equal(
        await failure(
          database.query(
            "INSERT INTO agent_job_runs (id, job_id, scheduled_for, status, finished_at) VALUES ($1, $2, $3, 'completed', now())",
            [randomUUID(), build.id, "2026-11-05T10:05:00Z"],
          ),
        ),
        "23505",
      );
      assert.equal(
        await failure(
          database.query(
            "UPDATE agent_job_runs SET status = 'running' WHERE id = $1",
            [runId],
          ),
        ),
        "23514",
      );

      // Lifecycle moves forward only.
      await jobs.markRunning(allJobs, runId, "2026-11-05T10:05:03.000Z");
      await jobs.finishRun(allJobs, runId, {
        status: "completed",
        finishedAt: "2026-11-05T10:06:00.000Z",
        startedAt: "2026-11-05T10:05:03.000Z",
        error: null,
      });
      await jobs.finishRun(allJobs, runId, {
        status: "failed",
        finishedAt: "2026-11-05T10:07:00.000Z",
        startedAt: null,
        error: "late",
      });
      await jobs.markRunning(allJobs, runId, "2026-11-05T10:08:00.000Z");
      assert.deepEqual(await jobs.runs(scope, build.id), [
        {
          id: runId,
          jobId: build.id,
          scheduledFor: "2026-11-05T10:05:00.000Z",
          status: "completed",
          startedAt: "2026-11-05T10:05:03.000Z",
          finishedAt: "2026-11-05T10:06:00.000Z",
          error: null,
        },
      ]);
      assert.deepEqual(
        await jobs.runs({ ownerId: "other", agentId: avery }, build.id),
        [],
      );

      // A manual run is a separate occurrence; restart recovery fails it rather than replaying it.
      const manual = await jobs.startNow(scope, build.id, later.toISOString());
      assert.equal(manual.manual, true);
      assert.equal(
        (await jobs.latestRuns(scope, [build.id])).get(build.id)?.id,
        manual.run.id,
      );
      assert.equal(
        await jobs.interruptActive(
          allJobs,
          "2026-11-05T11:00:05.000Z",
          "Restarted.",
        ),
        1,
      );
      assert.equal((await jobs.runs(scope, build.id))[0]?.status, "failed");

      // Pruning keeps the retained history.
      for (let index = 0; index < jobLimits.retainedRuns + 5; index++) {
        const at = new Date(
          Date.parse("2026-11-06T00:00:00Z") + index * 60_000,
        );
        const run = await jobs.startNow(scope, build.id, at.toISOString());
        await jobs.finishRun(allJobs, run.run.id, {
          status: "cancelled",
          finishedAt: at.toISOString(),
          startedAt: null,
          error: "Stopped.",
        });
      }
      assert.deepEqual(
        await database.query(
          "SELECT count(*)::int AS count FROM agent_job_runs WHERE job_id = $1",
          [build.id],
        ),
        [{ count: jobLimits.retainedRuns }],
      );

      // A paused job isn't due; a due one without a run is.
      await jobs.update(scope, build.id, {
        enabled: false,
        updatedAt: "2026-11-06T03:00:00.000Z",
      });
      assert.deepEqual(
        await jobs.due(allJobs, new Date("2026-11-07T00:00:00Z"), 20),
        [],
      );
      const once = await jobs.create(
        scope,
        job({
          schedule: { type: "once", at: "2026-11-07T09:00:00.000Z" },
          nextRunAt: "2026-11-07T09:00:00.000Z",
        }),
      );
      const dueNow = new Date("2026-11-07T09:00:01.000Z");
      assert.deepEqual(await jobs.due(allJobs, dueNow, 20), [
        { id: once.id, nextRunAt: "2026-11-07T09:00:00.000Z" },
      ]);
      await jobs.claim(allJobs, once.id, dueNow, (target) =>
        advanceAfterClaim(target, dueNow),
      );
      const finished = await jobs.getById(scope, once.id);
      assert.equal(finished?.enabled, false);
      assert.equal(finished?.nextRunAt, "2026-11-07T09:00:00.000Z");

      // The per-teammate limit holds under concurrent creation.
      const results = await Promise.allSettled(
        Array.from({ length: jobLimits.jobsPerTeammate }, () =>
          jobs.create(scope, job()),
        ),
      );
      assert.equal(
        results.filter((result) => result.status === "fulfilled").length,
        jobLimits.jobsPerTeammate - 2,
      );
      assert.ok(
        results.every(
          (result) =>
            result.status === "fulfilled" ||
            result.reason instanceof JobLimitError,
        ),
      );

      // Deleting the teammate removes its jobs and their runs.
      await database.getRepository(AgentEntity).delete({ id: avery });
      assert.deepEqual(
        await database.query(
          "SELECT (SELECT count(*)::int FROM agent_jobs) AS jobs, (SELECT count(*)::int FROM agent_job_runs) AS runs",
        ),
        [{ jobs: 0, runs: 0 }],
      );

      // The migration reverts and reapplies cleanly.
      await database.undoLastMigration({ transaction: "all" });
      await database.runMigrations();
      assert.deepEqual(await drift(database), []);
    } finally {
      if (database.isInitialized) await database.destroy();
      await admin.query(`DROP DATABASE IF EXISTS "${name}"`);
      await admin.end();
    }
  },
);
