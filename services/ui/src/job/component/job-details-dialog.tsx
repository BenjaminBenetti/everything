import { useEffect, useId, useState } from "react";
import { Pause, Pencil, Play, Square, Trash2 } from "lucide-react";
import type { JobRun } from "@everything/agent-contracts/job";
import { Button } from "@everything/ui/button";
import { Dialog } from "@everything/ui/dialog";
import { useJobActions, useJobRuns, useJobs } from "../hook/use-jobs.js";
import {
  describeSchedule,
  formatDateTime,
  jobStatus,
  runStatusLabels,
} from "../model/job-draft.js";

/** What happened during a run, in a few words. */
function runDetail(run: JobRun, teammateName: string): string {
  if (run.status === "pending") return `Waiting for ${teammateName} to start`;
  if (run.status === "running")
    return `Started ${formatDateTime(run.startedAt!)}`;
  if (run.startedAt && run.finishedAt) {
    const seconds = Math.max(
      0,
      Math.round(
        (Date.parse(run.finishedAt) - Date.parse(run.startedAt)) / 1000,
      ),
    );
    return seconds < 60
      ? `Took ${seconds} s`
      : `Took ${Math.round(seconds / 60)} min`;
  }
  return run.finishedAt ? `Ended ${formatDateTime(run.finishedAt)}` : "";
}

/** Show one job's schedule, instructions, controls, and recent runs. */
export function JobDetailsDialog({
  agentId,
  teammateName,
  jobId,
  onClose,
  onEdit,
}: {
  agentId: string;
  teammateName: string;
  jobId: string;
  onClose: () => void;
  onEdit: () => void;
}) {
  const runsHeading = useId();
  const jobs = useJobs(agentId);
  const job = jobs.data?.find((item) => item.id === jobId);
  const runs = useJobRuns(agentId, jobId);
  const actions = useJobActions(agentId);
  const [confirmingDelete, setConfirmingDelete] = useState(false);
  // Deleted here or elsewhere: there is nothing left to show.
  const missing = !!jobs.data && !job;
  useEffect(() => {
    if (missing) onClose();
  }, [missing, onClose]);
  if (!job) return null;
  const browserZone = Intl.DateTimeFormat().resolvedOptions().timeZone;
  const active =
    job.latestRun?.status === "pending" || job.latestRun?.status === "running";
  const busy = [
    actions.update,
    actions.remove,
    actions.runNow,
    actions.stop,
  ].some((action) => action.isPending);
  const error = [actions.update, actions.remove, actions.runNow, actions.stop]
    .map((action) => action.error?.message)
    .find(Boolean);
  const status = jobStatus(job);
  return (
    <Dialog
      title={job.name}
      description={describeSchedule(job.schedule)}
      className="job-details"
      onClose={onClose}
      dismissible={!actions.remove.isPending}
      footer={
        <div className="dialog-actions">
          <Button variant="light" onClick={onClose}>
            Close
          </Button>
        </div>
      }
    >
      <dl className="job-facts">
        <div>
          <dt>Status</dt>
          <dd className="chat-job-status" data-tone={status.tone}>
            {status.label}
          </dd>
        </div>
        {job.nextRunAt &&
          job.schedule.type === "cron" &&
          job.schedule.timezone !== browserZone && (
            <div>
              <dt>In {job.schedule.timezone}</dt>
              <dd>
                {formatDateTime(
                  job.nextRunAt,
                  undefined,
                  job.schedule.timezone,
                )}
              </dd>
            </div>
          )}
        <div>
          <dt>Instructions</dt>
          <dd className="job-instructions">{job.instructions}</dd>
        </div>
      </dl>
      <div className="job-actions">
        {active ? (
          <Button
            variant="light"
            disabled={busy}
            onClick={() => actions.stop.mutate(job.id)}
          >
            <Square aria-hidden="true" /> Stop run
          </Button>
        ) : (
          <Button
            variant="light"
            disabled={busy}
            onClick={() => actions.runNow.mutate(job.id)}
          >
            <Play aria-hidden="true" /> Run now
          </Button>
        )}
        <Button
          variant="light"
          disabled={busy}
          onClick={() =>
            actions.update.mutate({
              jobId: job.id,
              input: { enabled: !job.enabled },
            })
          }
        >
          {job.enabled ? (
            <>
              <Pause aria-hidden="true" /> Pause
            </>
          ) : (
            <>
              <Play aria-hidden="true" /> Resume
            </>
          )}
        </Button>
        <Button variant="light" disabled={busy} onClick={onEdit}>
          <Pencil aria-hidden="true" /> Edit
        </Button>
        <Button
          variant="danger-quiet"
          disabled={busy}
          onClick={() => setConfirmingDelete(true)}
        >
          <Trash2 aria-hidden="true" /> Delete
        </Button>
      </div>
      <p className="job-hint">
        Pause stops future runs but lets a current run finish. Stop run ends
        only this job’s current run; later runs still happen.
      </p>
      {confirmingDelete && (
        <div
          className="job-delete-confirm"
          role="group"
          aria-label="Delete job"
        >
          <p>
            Delete “{job.name}” and its run history? A run in progress stops.
          </p>
          <div className="job-delete-actions">
            <Button
              variant="light"
              autoFocus
              disabled={actions.remove.isPending}
              onClick={() => setConfirmingDelete(false)}
            >
              Keep job
            </Button>
            <Button
              variant="danger"
              disabled={actions.remove.isPending}
              onClick={() =>
                actions.remove.mutate(job.id, { onSuccess: onClose })
              }
            >
              {actions.remove.isPending ? "Deleting…" : "Delete job"}
            </Button>
          </div>
        </div>
      )}
      {error && (
        <p className="form-error" role="alert">
          {error}
        </p>
      )}
      <section className="job-runs" aria-labelledby={runsHeading}>
        <h3 id={runsHeading}>Recent runs</h3>
        {runs.isPending ? (
          <p className="job-runs-notice" role="status">
            Loading runs…
          </p>
        ) : runs.isError ? (
          <p className="job-runs-notice" role="status">
            Run history is unavailable right now. Retrying…
          </p>
        ) : runs.data.length === 0 ? (
          <p className="job-runs-notice">No runs yet.</p>
        ) : (
          <ol className="job-run-list">
            {runs.data.map((run) => (
              <li key={run.id} className="job-run" data-status={run.status}>
                <span className="job-run-status">
                  {runStatusLabels[run.status]}
                </span>
                <time className="job-run-time" dateTime={run.scheduledFor}>
                  {formatDateTime(run.scheduledFor)}
                </time>
                <span className="job-run-detail">
                  {runDetail(run, teammateName)}
                </span>
                {run.error && (
                  <span className="job-run-error">{run.error}</span>
                )}
              </li>
            ))}
          </ol>
        )}
      </section>
    </Dialog>
  );
}
