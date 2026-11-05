import { useId, useState, type FormEvent } from "react";
import { jobLimits, type AgentJob } from "@everything/agent-contracts/job";
import { Button } from "@everything/ui/button";
import { Dialog } from "@everything/ui/dialog";
import { Select } from "@everything/ui/select";
import { useJobActions, useJobPreview } from "../hook/use-jobs.js";
import {
  draftFromJob,
  emptyDraft,
  formatDateTime,
  jobChanges,
  scheduleFromDraft,
  timezoneOptions,
  type IntervalUnit,
  type JobDraft,
} from "../model/job-draft.js";

/** Schedule types, in the order offered. */
const scheduleKinds = [
  { value: "interval", label: "Repeat every…" },
  { value: "once", label: "Once" },
  { value: "cron", label: "Cron schedule" },
] as const;

/** Interval units, in the order offered. */
const intervalUnits = [
  { value: "minutes", label: "minutes" },
  { value: "hours", label: "hours" },
  { value: "days", label: "days" },
] as const;

/** Create a job or change one, previewing the server's next times before saving. */
export function JobEditor({
  agentId,
  teammateName,
  job,
  onClose,
}: {
  agentId: string;
  teammateName: string;
  job?: AgentJob;
  onClose: () => void;
}) {
  const formId = useId();
  const previewId = useId();
  const browserZone = Intl.DateTimeFormat().resolvedOptions().timeZone;
  const [draft, setDraft] = useState<JobDraft>(() =>
    job
      ? draftFromJob(job, new Date(), browserZone)
      : emptyDraft(new Date(), browserZone),
  );
  const parsed = scheduleFromDraft(draft);
  const schedule = "schedule" in parsed ? parsed.schedule : undefined;
  const preview = useJobPreview(agentId, schedule);
  const { create, update } = useJobActions(agentId);
  const save = job ? update : create;
  const ready =
    !!draft.name.trim() &&
    !!draft.instructions.trim() &&
    !!schedule &&
    !preview.isError;
  /** Change one field of the draft. */
  function set<K extends keyof JobDraft>(field: K, value: JobDraft[K]): void {
    setDraft((current) => ({ ...current, [field]: value }));
  }
  /** Save once; an edit sends only what changed. */
  function submit(event: FormEvent<HTMLFormElement>): void {
    event.preventDefault();
    if (!ready || !schedule || save.isPending) return;
    if (!job) {
      create.mutate(
        {
          name: draft.name.trim(),
          instructions: draft.instructions.trim(),
          schedule,
        },
        { onSuccess: onClose },
      );
      return;
    }
    const input = jobChanges(job, draft.name, draft.instructions, schedule);
    if (!Object.keys(input).length) onClose();
    else update.mutate({ jobId: job.id, input }, { onSuccess: onClose });
  }
  return (
    <Dialog
      title={job ? "Edit job" : "New job"}
      description={`A job wakes ${teammateName} on a schedule in a private background session with its usual tools and workspace. Its final reply goes to ${teammateName}’s chat, which tells you when something matters.`}
      className="job-editor"
      onClose={() => !save.isPending && onClose()}
      dismissible={!save.isPending}
      footer={
        <div className="dialog-actions">
          <Button variant="light" disabled={save.isPending} onClick={onClose}>
            Cancel
          </Button>
          <Button
            form={formId}
            type="submit"
            disabled={!ready || save.isPending}
          >
            {save.isPending ? "Saving…" : job ? "Save changes" : "Create job"}
          </Button>
        </div>
      }
    >
      <form id={formId} onSubmit={submit} aria-busy={save.isPending}>
        <label className="field">
          Name
          <input
            autoFocus
            required
            maxLength={jobLimits.nameLength}
            placeholder="e.g. Morning PR check"
            value={draft.name}
            onChange={(event) => set("name", event.target.value)}
            disabled={save.isPending}
          />
        </label>
        <label className="field">
          Instructions
          <textarea
            required
            rows={4}
            maxLength={jobLimits.instructionsLength}
            placeholder="What should be checked, and when should you hear about it?"
            value={draft.instructions}
            onChange={(event) => set("instructions", event.target.value)}
            disabled={save.isPending}
          />
          <small>
            Each run starts fresh. Ask {teammateName} to keep notes in its
            workspace if a later run needs them.
          </small>
        </label>
        <div className="field">
          <span>Schedule</span>
          <Select
            label="Schedule"
            value={draft.kind}
            options={scheduleKinds}
            placeholder="Choose a schedule"
            disabled={save.isPending}
            onValueChange={(value) => set("kind", value as JobDraft["kind"])}
          />
        </div>
        {draft.kind === "once" && (
          <label className="field">
            Date and time
            <input
              type="datetime-local"
              required
              value={draft.onceAt}
              onChange={(event) => set("onceAt", event.target.value)}
              disabled={save.isPending}
            />
            <small>In your timezone, {browserZone}.</small>
          </label>
        )}
        {draft.kind === "interval" && (
          <div className="field job-interval">
            <label htmlFor={`${formId}-amount`}>Every</label>
            <div className="job-interval-inputs">
              <input
                id={`${formId}-amount`}
                inputMode="numeric"
                pattern="[0-9]*"
                required
                value={draft.intervalAmount}
                onChange={(event) => set("intervalAmount", event.target.value)}
                disabled={save.isPending}
              />
              <Select
                label="Interval unit"
                value={draft.intervalUnit}
                options={intervalUnits}
                placeholder="Unit"
                disabled={save.isPending}
                onValueChange={(value) =>
                  set("intervalUnit", value as IntervalUnit)
                }
              />
            </div>
            <small>
              The first run is one interval after you save. At least five
              minutes.
            </small>
          </div>
        )}
        {draft.kind === "cron" && (
          <>
            <label className="field">
              Cron expression
              <input
                className="job-cron-input"
                required
                spellCheck={false}
                autoCapitalize="off"
                autoComplete="off"
                maxLength={jobLimits.cronLength}
                value={draft.cronExpression}
                onChange={(event) => set("cronExpression", event.target.value)}
                disabled={save.isPending}
              />
              <small>
                Five numbers or ranges: minute, hour, day of month, month, and
                day of week. 0 9 * * 1-5 runs at 9:00 on weekdays.
              </small>
            </label>
            <div className="field">
              <span>Timezone</span>
              <Select
                label="Timezone"
                value={draft.timezone}
                options={timezoneOptions(draft.timezone).map((zone) => ({
                  value: zone,
                  label: zone,
                }))}
                placeholder="Choose a timezone"
                disabled={save.isPending}
                onValueChange={(value) => set("timezone", value)}
              />
            </div>
          </>
        )}
        <div className="job-preview" id={previewId} aria-live="polite">
          <span className="eyebrow">Next runs</span>
          {"error" in parsed ? (
            <p className="job-preview-note">{parsed.error}</p>
          ) : preview.isError ? (
            <p className="job-preview-error">{preview.error.message}</p>
          ) : !preview.data ? (
            <p className="job-preview-note">Checking the schedule…</p>
          ) : (
            <ol>
              {preview.data.map((run) => (
                <li key={run}>
                  <time dateTime={run}>{formatDateTime(run)}</time>
                  {schedule?.type === "cron" &&
                    schedule.timezone !== browserZone && (
                      <span className="muted">
                        {" "}
                        · {formatDateTime(
                          run,
                          undefined,
                          schedule.timezone,
                        )} in {schedule.timezone}
                      </span>
                    )}
                </li>
              ))}
            </ol>
          )}
          {job &&
            schedule &&
            jobChanges(job, job.name, job.instructions, schedule).schedule && (
              <p className="job-preview-note">
                Saving a new schedule restarts timing from now.
              </p>
            )}
        </div>
        {save.isError && (
          <p className="form-error" role="alert">
            {save.error.message}
          </p>
        )}
      </form>
    </Dialog>
  );
}
