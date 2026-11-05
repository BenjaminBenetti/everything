import { useId, useState } from "react";
import { CalendarClock, Plus } from "lucide-react";
import type { Agent } from "@everything/agent-contracts";
import { IconButton } from "@everything/ui/button";
import { useJobs } from "../hook/use-jobs.js";
import { describeSchedule, jobStatus } from "../model/job-draft.js";
import { JobDetailsDialog } from "./job-details-dialog.js";
import { JobEditor } from "./job-editor.js";

/** The dialog the card has open, if any. */
type JobDialog =
  | { kind: "new" }
  | { kind: "details"; jobId: string }
  | { kind: "edit"; jobId: string };

/** Remember the control that opened a dialog, so closing it returns focus there. */
function markOpener(): void {
  document
    .querySelector("[data-dialog-return]")
    ?.removeAttribute("data-dialog-return");
  if (document.activeElement instanceof HTMLElement)
    document.activeElement.setAttribute("data-dialog-return", "");
}

/** List the teammate's scheduled jobs beside the chat, with their next time or current state. */
export function JobsCard({ agent }: { agent: Agent }) {
  const heading = useId();
  const jobs = useJobs(agent.id);
  const [dialog, setDialog] = useState<JobDialog | null>(null);
  const list = jobs.data ?? [];
  const editing =
    dialog?.kind === "edit"
      ? list.find((job) => job.id === dialog.jobId)
      : undefined;
  return (
    <aside className="chat-jobs-card" aria-labelledby={heading}>
      <div className="chat-jobs-head">
        <h2 id={heading}>
          <CalendarClock aria-hidden="true" /> Jobs
        </h2>
        <IconButton
          label="New job"
          className="chat-jobs-new"
          onClick={() => {
            markOpener();
            setDialog({ kind: "new" });
          }}
        >
          <Plus aria-hidden="true" />
        </IconButton>
      </div>
      {jobs.isPending ? (
        <p className="chat-jobs-notice" role="status">
          Loading jobs…
        </p>
      ) : jobs.isError ? (
        <p className="chat-jobs-notice" role="status">
          Jobs are unavailable right now. Retrying…
        </p>
      ) : list.length === 0 ? (
        <p className="chat-jobs-notice">
          No jobs yet. A job wakes {agent.name} on a schedule to check something
          and tell you when it matters.
        </p>
      ) : null}
      {!agent.inference && list.length > 0 && (
        <p className="chat-jobs-notice" role="status">
          Runs fail until you choose a model for {agent.name}.
        </p>
      )}
      {list.length > 0 && (
        <ul className="chat-job-list" aria-label={`${agent.name}’s jobs`}>
          {list.map((job) => {
            const status = jobStatus(job);
            return (
              <li key={job.id}>
                <button
                  type="button"
                  className="chat-job-row"
                  onClick={() => {
                    markOpener();
                    setDialog({ kind: "details", jobId: job.id });
                  }}
                >
                  <span className="chat-job-name">{job.name}</span>
                  <span className="chat-job-schedule">
                    {describeSchedule(job.schedule)}
                  </span>
                  <span className="chat-job-status" data-tone={status.tone}>
                    {status.label}
                  </span>
                </button>
              </li>
            );
          })}
        </ul>
      )}
      {dialog?.kind === "new" && (
        <JobEditor
          agentId={agent.id}
          teammateName={agent.name}
          onClose={() => setDialog(null)}
        />
      )}
      {dialog?.kind === "details" && (
        <JobDetailsDialog
          agentId={agent.id}
          teammateName={agent.name}
          jobId={dialog.jobId}
          onClose={() => setDialog(null)}
          onEdit={() => setDialog({ kind: "edit", jobId: dialog.jobId })}
        />
      )}
      {dialog?.kind === "edit" && editing && (
        <JobEditor
          agentId={agent.id}
          teammateName={agent.name}
          job={editing}
          onClose={() => setDialog({ kind: "details", jobId: editing.id })}
        />
      )}
    </aside>
  );
}
