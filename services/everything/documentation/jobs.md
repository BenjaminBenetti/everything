# Scheduled jobs

A teammate's owner can give it **jobs**: named instructions that run on a schedule, such as "each weekday at 09:00, list pull requests waiting for my review and tell me if one is older than two days". Each run uses the path Everything already has for background events:

```
scheduler ──► existing wakeup ──► temporary private background session ──► final reply to main ──► main messages the user if useful
```

There is no separate result format, reporting tool, or notification queue. A run's background session has the teammate's normal tools, workspace, and permissions, starts with fresh context, and is removed when it finishes, like any wakeup. Its final reply reaches main as an ordinary private message, and main decides whether to tell the user. Saving a job authorizes its scheduled runs; it grants no other permissions.

## Schedules

| Type       | Example                                                                | Behavior                                                                                                                                                                        |
| ---------- | ---------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `once`     | `{"type":"once","at":"2026-12-01T09:00:00Z"}`                          | Runs at that instant, then turns itself off and keeps the time for reference. The instant needs a UTC offset or `Z`, must be in the future, and at most about five years ahead. |
| `interval` | `{"type":"interval","seconds":900}`                                    | First runs one interval after saving or resuming, then on that grid. 300 seconds (five minutes) to 365 days.                                                                    |
| `cron`     | `{"type":"cron","expression":"0 9 * * 1-5","timezone":"Europe/Paris"}` | Five numeric fields (minute, hour, day of month, month, day of week) in an IANA timezone, following its daylight saving changes. Matches must be at least five minutes apart.   |

- Cron supports digits, `*`, lists, ranges, and steps, combining day of month and day of week with OR, as standard cron does. Names, seconds, `L`, `W`, `#`, and `?` are refused. A time skipped by a spring-forward change runs an hour later that day; a time repeated by a fall-back change runs once.
- `next_run_at` is stored in UTC. The UI previews the next three times from the server in the browser's timezone, and in the job's timezone for cron.
- A teammate can have 25 jobs. `POST /v1/agents/{agentId}/jobs/preview` checks a schedule without saving it.

## When runs happen

- **Missed times are coalesced.** The scheduler checks every 15 seconds. After downtime, a job that missed several times runs **once** and then moves to its next future time; nothing is replayed. Interval jobs stay on the grid anchored at their due times, so late dispatch never drifts them.
- **Runs never overlap.** While a run is pending or running, its job isn't due. Times it misses meanwhile are coalesced into one run after it ends. The database also allows only one pending or running run per job.
- **Each occurrence is recorded once.** `UNIQUE(job_id, scheduled_for)` prevents a second row for the same occurrence. This doesn't promise that what the teammate does happens exactly once outside Everything.
- **Run now** records a separate occurrence for the current time. It works while the job is paused, doesn't change the schedule, and is refused (409) while another run of the job is active.

## Run history

`agent_job_runs` records operational lifecycle only, never what the teammate found:

| Status      | Meaning                                                                                                                                                                                                                                      |
| ----------- | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `pending`   | Claimed, and waiting for the teammate to accept the wakeup.                                                                                                                                                                                  |
| `running`   | The temporary session accepted the task (`started_at`). Acceptance is never treated as completion.                                                                                                                                           |
| `completed` | The session's last turn ended normally and the session was removed. "I couldn't find anything" is a completed run.                                                                                                                           |
| `failed`    | The wakeup was refused before acceptance (for example no model, a disconnected provider, or eight background tasks already running), the session's turn errored, or Everything restarted during the run. `error` holds a short, safe reason. |
| `cancelled` | Stopped before it finished: by **Stop run**, by deleting the job, by the teammate's Stop, by pausing before acceptance, or by shutdown.                                                                                                      |

Running, completed, failed, and cancelled come from the runtime itself: the session family reports when a temporary session accepts its task and, once, how it ended after its subtree is removed. A refusal because the teammate's eight background slots are full is retried a few times over about a minute, since nothing was accepted. Other refusals end the run at once, and an error that might hide an acceptance is never sent again. Each job keeps its latest 100 runs; the API returns the latest 20. Provider errors and transcripts are never stored.

## Pause, stop, and delete

- **Pause** (`enabled: false`) stops future runs. It withdraws a run the teammate hasn't accepted yet, and lets a running one finish. Resuming restarts timing from now, without running missed times. A one-time job whose time has passed can't be resumed until it has a future time (409).
- **Stop run** (`POST …/jobs/{jobId}/stop`) cancels only this job's current run and removes its background subtree; main and other background work continue, and the job stays on its schedule.
- **The teammate's Stop** cancels every running session, including a job's run, but doesn't pause jobs. Like every wakeup, the next scheduled run wakes the teammate again; pause a job to prevent that.
- **Delete** removes the job and its history and stops its current run. Deleting the teammate deletes its jobs.

## Restarts and limits

- Schedules live in PostgreSQL and survive restarts. Before accepting requests, Everything marks runs still pending or running from the previous process as failed ("Everything restarted before this run finished"). They aren't replayed, and none are assumed to have succeeded; a finished one-time job stays off.
- Claims and edits of one job are serialized in the process and by row locks, and dispatch happens only after the claim commits, so a pause committed first always prevents the run. No database transaction is held while the teammate works.
- **Single replica.** Following runs and startup recovery assume the one API replica the chart runs. Claims are safe across processes, but recovery would fail another live process's runs, so the scheduler isn't designed for several replicas.
- A run's model work is billed to the teammate's provider like any other turn. Jobs don't probe providers or models.

## Teammate tools

A teammate's main session can configure its own jobs with four tools. They call the same job service as the API, so they have the same checks, limits, errors, and pause semantics:

| Tool         | Arguments                                                      | Does                                                                                                        |
| ------------ | -------------------------------------------------------------- | ----------------------------------------------------------------------------------------------------------- |
| `create_job` | `name`, `instructions`, `schedule`, optional `enabled`         | Creates a job and returns its ID, schedule, whether it's on, and next run time                              |
| `list_jobs`  | none                                                           | Lists the teammate's jobs with their latest run's status; long instructions are shortened to 500 characters |
| `update_job` | `id`, and any of `name`, `instructions`, `schedule`, `enabled` | `enabled: false` pauses later runs (a current run finishes); `enabled: true` resumes from now               |
| `delete_job` | `id`                                                           | Deletes the job and its history, stopping only its current run                                              |

- **Scope:** the tools are bound to the session's saved teammate and its owner by the runtime. They take no owner or teammate argument; extra fields are refused before the job service runs, and other teammates' jobs look missing.
- **Main only:** forks, event wakeups, and job runs don't get them, so background work that reads outside content can't schedule more work.
- **Explicit requests:** the main prompt says to use them only when the user asks for scheduled or later work, never because a page, file, tool result, or background session asks, and to ask for a timezone it doesn't know instead of guessing.
- **Not included:** running, stopping, or previewing jobs, and run history, stay in the UI and API.

Example calls a teammate might make:

```json
{
  "name": "Morning PRs",
  "instructions": "List open pull requests waiting for my review; tell me only if one is older than two days.",
  "schedule": {
    "type": "cron",
    "expression": "0 9 * * 1-5",
    "timezone": "Europe/Paris"
  }
}
```

```json
{ "id": "0f7c2a4e-5b1d-4c8e-9a3f-6d2e1b7c9a10", "enabled": false }
```

The first is `create_job`; the second, `update_job`, pauses that job.

## Tests and screenshots

- **CI coverage:** CI's Build and test job runs the jobs PostgreSQL test against a disposable `postgres:17.11-bookworm` (**Jobs PostgreSQL integration**: exactly one test, which must pass and must not skip). It also runs the desktop and phone browser harness (**Jobs browser harness**: both tests must pass on their only attempt).
- **Artifact:** the harness's screenshots and records are uploaded as `jobs-browser-proof-<run>-<attempt>`.
- **Published screenshots:** unedited screenshots from a passing CI run, with what was real and what was synthetic, are in [`services/ui/documentation/assets/jobs/README.md`](../../ui/documentation/assets/jobs/README.md).
