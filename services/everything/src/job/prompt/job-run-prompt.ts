import type { ClaimedJobRun } from "../model/job.js";
import { describeSchedule } from "../model/job-schedule.js";

/**
 * The task a job's temporary background session receives. It runs through the normal tools and
 * workspace, and its final reply reaches main through ordinary private delivery, as any wakeup does.
 */
export function jobRunPrompt({ job, run, manual }: ClaimedJobRun): string {
  return [
    `Scheduled job "${job.name}", which runs ${describeSchedule(job.schedule)}.`,
    manual
      ? `The user started this run with Run now at ${run.scheduledFor}.`
      : `This run was due at ${run.scheduledFor}.`,
    "",
    "The user's instructions for this job:",
    job.instructions,
    "",
    "This is a fresh session: earlier runs of this job aren't in your context, so keep notes in your workspace when a later run needs them. When you finish, your final reply goes to your main conversation, which decides whether to tell the user; say plainly when there's nothing new.",
  ].join("\n");
}
