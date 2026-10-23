# Telemetry

The Telemetry page (desktop only, after Keys in the sidebar) shows why something didn’t work: a model or provider error that a teammate turned into “Your teammate couldn’t finish replying”, a failed request to Everything, or the requests, database queries, and tool calls around it. Everything records them with OpenTelemetry, stores them in a single [OpenObserve](https://github.com/openobserve/openobserve) node for about a week, and reads them back through its own API, so the page needs no OpenObserve login and each owner sees only their own records.

```text
Everything (API + Pi runtime) ── OTLP/HTTP, Basic auth ──▶ openobserve (StatefulSet, PVC, ClusterIP only)
        ▲                                                         │
        └──────── /v1/telemetry/* (owner-scoped SQL it builds) ◀──┘
Browser ── same-origin session ──▶ /v1/telemetry/*
```

## What is recorded

Only the Everything API process exports telemetry. Its instrumentation is preloaded with `node --import ./build/telemetry/bootstrap/instrumentation.js` (the container's command and `pnpm start`), before Fastify, `pg`, or anything it instruments loads.

| Source | Recorded as | Notes |
| --- | --- | --- |
| Model requests | `provider.request` spans for each HTTP attempt, timed until the provider’s response headers, with status, the provider’s request ID, `Retry-After`, and for error responses the provider’s error code and, [if error text is recorded](#privacy-and-redaction), an excerpt of its error message. | Attempts are numbered when an SDK retries; Everything’s own turns make one attempt, since Pi’s retries are off. A failure is diagnosed from its final attempt only: a network failure after a retried 429 is a network failure, while each attempt’s span keeps its own response. The streamed response belongs to the prompt’s span, which records a stream that fails after a successful response. |
| Model failures | `model.request.failed` events with a category (`rate_limit`, `quota`, `overloaded`, `context_length`, `authentication`, `stream_interrupted`, …), code, HTTP status, request ID, attempts, whether retrying may help, provider, model, and, if error text is recorded, an excerpt of the error’s message. | Captured from Pi’s final assistant message before the runtime reduces it to a generic error, including streams that fail after HTTP 200. A stop is recorded separately as `model.request.cancelled`. |
| Teammate turns | A `teammate.turn` span per turn, starting its own trace linked to the request that started it, with `teammate.prompt` spans, `teammate.tool` spans (name, duration, failed or not), and `teammate.compaction` spans. `turn.failed` and `turn.cancelled` events record the outcome. | Background forks and monitor wakeups record their prompts as traces of their own, and so does a message a fork sends to the main conversation, even when it waits behind a user’s turn; it is linked to the work that sent it, never part of that turn’s run. Tool arguments and results are not recorded, and a tool’s name only when it is a well-formed identifier. |
| Context compaction | `compaction.failed` and `compaction.cancelled` events, with the reason, whether Pi will retry, and the failure’s category, code, and status. | |
| Requests to Everything | Server spans named by route (`POST /v1/agents/:agentId/messages`), with status, and an `http.request.failed` event for 5xx responses: the error’s class, code, and stack frames as code locations for unexpected failures, and, if error text is recorded, its redacted message and those of its causes. | `/health` probes aren’t traced. Successful, quick `GET`/`HEAD` requests are kept at `TELEMETRY_READ_SAMPLE_RATIO` (5%); failed, client-error, and slow (≥2 s) reads are kept with every child span. |
| Dependencies | `fetch` (Undici) client spans and PostgreSQL query spans inside traced work. | SQL text, parameters, and connection strings are dropped; only the operation, database, and table remain. |
| Background warnings | `app.warning` events for Fleet, SSH key synchronization, workspace reconciliation, monitor delivery, update summaries, provider checks, and voice. | They belong to no owner, so they appear on nobody’s Telemetry page; see [Operator access](#operator-access). The same lines still go to standard error. |

Not collected: logs of other pods (UI, artifact, Keycloak, PostgreSQL, registry, voice, upgrader, teammate pods, Fleet instances), standard output or Fastify’s access log, Kubernetes events, metrics, browser errors, and anything in Pi’s private session files. There is no cluster-wide log collector.

## Privacy and redaction

Records are made safe in the process, before export:

- Only allowlisted attributes leave the process: Everything’s own, plus HTTP method, route, status, host, path, database system and operation, and error type. Anything else a library records, such as headers, user agents, client addresses, SQL statements, or connection strings, is dropped. URLs lose user information, query strings, and fragments, and credentials in their paths, such as a key in a gateway’s base path, are redacted, including percent-encoded ones.
- **Error text is withheld by default.** What a provider, SDK, library, or thrown error says can quote what was sent, such as part of a prompt, and no redaction can reliably recognize ordinary private text. Unless `telemetry.includeErrorText` is `true`, Everything leaves that text out of every record before export: event messages, the status messages of its own and of instrumented libraries’ spans, exception messages, and the messages of nested causes. Records keep structured facts: category, provider code or error type, HTTP status, provider request ID, provider and model, attempts, whether retrying may help, Everything’s own status text (such as `Model request failed: rate_limit`, `Context compaction failed`, or `HTTP 429`), its plain-language diagnosis and next step, and stack frames as code locations. A record whose text was left out is marked, and the page says the text was withheld rather than showing nothing.
- **Recording error text is an explicit choice.** With `telemetry.includeErrorText: true`, error text is redacted and cut to 400 characters (a provider’s excerpt to 300). Only an error’s own message is kept: the `message` of a provider’s JSON error body, or an SDK or transport message such as `Connection error.`. A body’s other fields, a body without a message, and non-JSON response bodies are never kept. The text can still quote part of a prompt or other private text, which redaction does not remove; it is visible only to the record’s owner, for the retention period. Changing the setting affects records made after Everything restarts with it, not records already stored.
- In both modes, every text value is redacted for credential shapes (bearer and basic tokens, JWTs, provider API keys, cloud keys, private keys, `name=value` secrets in text, JSON, or headers, URL credentials and query strings, long opaque tokens, and email addresses) and bounded, with `…[truncated]` marking a cut. Error descriptions read only an error’s class, code, status, message, causes (three deep), and stack frames, never response bodies or other properties an SDK attaches. Redaction recognizes these shapes; it can’t promise to find every secret written some other way.
- Everything doesn’t record prompts, responses, thinking, tool arguments or results, or conversation text. Titles shown in lists are written by Everything.
- Only the first `2 × limit + 512` characters of any text are examined, so redaction takes the same short time however long or unusual an error message is, and a credential the cut splits leaves no fragment.

## Access control

- The page reads `/v1/telemetry/status`, `/events`, `/events/:eventId`, `/spans`, and `/traces/:traceId`, all behind the same authentication as the rest of `/v1`. The owner is always the verified caller: requests carry no owner, and every query Everything builds starts with the owner’s condition. Rows the backend returns are checked against the owner again before they’re shown. A trace or event of another owner answers exactly like one that doesn’t exist (404).
- Records are attributed when they are made, from verified identities and owned records: a request’s spans to its authenticated subject, including spans that began before authentication, and a teammate’s turns, prompts, and provider requests to the teammate’s owner. Unattributed records, such as unauthenticated requests and background warnings, are visible to nobody.
- Filters are validated against fixed patterns, and the query builder writes every value as an escaped SQL literal. OpenObserve’s SQL treats a backslash as an escape inside string literals, so doubling quotes alone isn’t enough; backslashes and control characters are refused both by the API schema and by the builder. There is no SQL, query, or admin passthrough.
- Apps a teammate shares act as their owner through the API, as they do for conversations, so they can read their owner’s telemetry too.

## Deployment

`services.openobserve` in [values.yaml](../helm/values.yaml) runs OpenObserve’s published image unchanged (`docker.io/openobserve/openobserve:v1.1.2`, pinned by digest, published for `linux/amd64` and `linux/arm64`; the same digest is on OpenObserve’s other registries), as one StatefulSet replica in local mode: SQLite metadata and Parquet files on its `openobserve-data` claim. It runs as user 1000 with a read-only root filesystem and no capabilities, has a ClusterIP Service on port 5080, and no Ingress.

| Setting | Default | Meaning |
| --- | --- | --- |
| `telemetry.retentionDays` | `7` | Days OpenObserve keeps (`ZO_COMPACT_DATA_RETENTION_DAYS`), and the range Everything’s API allows. 3 to 30. OpenObserve’s own default is 3650 days. |
| `telemetry.includeErrorText` | `false` | Record the redacted text of provider, SDK, and library error messages. It can quote prompts and other private text; see [Privacy and redaction](#privacy-and-redaction). |
| `services.openobserve.enabled` | `true` | `false` removes the service; Everything’s `TELEMETRY_URL` is then empty, nothing is exported, and the page says telemetry is turned off. |
| `services.openobserve.volumes.data.persistentVolume.size` | `5Gi` | The disk; the installer asks for it like the others. |
| `services.openobserve.resources` | requests 50m CPU, 128Mi; limits 1 CPU, 768Mi | See [Resources](#resources). |

Everything’s settings come from the chart: `TELEMETRY_URL` (the Service, or empty), `TELEMETRY_USERNAME`, `TELEMETRY_PASSWORD_FILE`, `TELEMETRY_RETENTION_DAYS`, `TELEMETRY_INCLUDE_ERROR_TEXT` (`true` or `false`; withheld unless exactly `true`), `TELEMETRY_SERVICE_VERSION`, and optionally `TELEMETRY_READ_SAMPLE_RATIO` (0–1) and `TELEMETRY_TIMEOUT_MS`. Malformed settings or an unreadable password file never stop Everything from starting; the page reports telemetry as unavailable.

**Credentials.** `templates/telemetry-credentials.yaml` derives OpenObserve’s root password from a purpose label and the session encryption key, as the Fleet gateway’s session key is, so no new install-time value is needed. OpenObserve reads it as `ZO_ROOT_USER_PASSWORD`; Everything mounts it as a file, so it is never in the environment fleetd and its commands inherit. Neither the browser nor teammate pods receive it. OpenObserve keeps the password it was first started with, so changing the session encryption key, which the installation treats as a stable master key, leaves the Secret and OpenObserve’s account disagreeing. With this chart, the recovery is to delete the `openobserve-data` claim, losing telemetry history, so OpenObserve starts over with the new password. That is a tradeoff of deriving the password from the key, not a limit of OpenObserve: giving OpenObserve its own persisted credential would avoid it, and isn’t done yet. Pods in the release namespace, including teammate pods, can reach the Service, but every data endpoint requires that password.

**No outside connections.** By default OpenObserve reports usage to its makers and downloads GeoIP databases, LLM prices, and redaction patterns from the internet, even with `ZO_TELEMETRY=false`. The chart turns all of them off (`ZO_TELEMETRY`, `ZO_MMDB_DISABLE_DOWNLOAD`, `ZO_MODEL_PRICING_ENABLED`, `ZO_REGEX_PATTERNS_SOURCE_URL`), along with its web UI, API documentation, MCP server, metrics endpoint, and query history. Observed over a 30-second start in its network namespace: the defaults connected to `raw.githubusercontent.com` and `geoip.zinclabs.dev`; the chart’s settings made no outside connections.

## Reliability and limits

- Export is asynchronous and bounded: spans and events wait in fixed queues (2048 spans, 1024 events) and are sent in batches every 2 s and 1 s over OTLP/HTTP with a 10 s deadline and the exporters’ backoff for retryable statuses. A slow or unreachable OpenObserve never delays or fails chat, provider calls, or requests; when the queues are full, further records are dropped and counted. Failed and dropped batches are reported on the page and by one line on standard error when exports start failing and when they recover.
- Shutdown flushes what is queued, within the export deadline. A crash, out-of-memory kill, or node loss loses what was still queued in Everything’s memory. OpenObserve writes received records to its write-ahead log on its disk; records survive its restarts (tested), but this is a single node without replication or backups.
- Retention is deletion by OpenObserve’s compactor: data older than `retentionDays` is removed within a few hours of expiring, not at the exact moment. Disk use depends on volume; there is no disk-based cap, so size the claim for your load and watch it.
- Spans are kept for every non-read request and for reads that fail or are slow; events are never sampled. The page’s own reads are queried with tracing suppressed.
- Records arrive in batches as work finishes, so a trace can be incomplete when it’s first opened. While **Watch for new records** is on, an open trace whose root span hasn’t arrived is checked every 5 seconds, for up to 10 minutes after the record. **Refresh** reloads the list from its newest page, even for an unchanged custom range, and reloads the open record and its trace, which stay open; older pages load again on request. A trace that can’t be loaded says so and offers **Try again**.

## Resources

OpenObserve’s sample Kubernetes manifest (requests 256m CPU and 50Mi, limits 4 CPU and 2Gi) is an example, not a measured minimum, and its defaults size caches and memory tables as a share of the node. The chart bounds them (`ZO_MEMORY_CACHE_MAX_SIZE` 64 MB, `ZO_MEMORY_CACHE_DATAFUSION_MAX_SIZE` 128 MB, `ZO_MEM_TABLE_MAX_SIZE` 64 MB, `ZO_MAX_FILE_SIZE_IN_MEMORY` 16 MB) and sets requests of 50m CPU and 128Mi, and limits of 1 CPU and 768Mi.

Measured on 2026-10-23 with OpenObserve v1.1.2 (amd64) in Docker, limited to 1 CPU and 768 MiB, with every setting the chart renders. The workload went through Everything’s own export pipeline: about five request traces a second, each with two PostgreSQL spans; a teammate turn every two seconds, with its prompt, three tool calls, and a provider request; and a model failure with its turn failure every ten seconds. After ingesting, 300 owner-scoped API queries ran (event pages, span searches, and trace lookups for three owners). Memory is Docker’s reported usage, sampled about every two seconds.

| Phase | Peak memory |
| --- | --- |
| Idle, first minute | 29 MiB |
| Ingesting for three minutes (897 request traces, 90 turns) | 39 MiB |
| 300 queries | 97 MiB |
| Afterwards, caches warm | 81 MiB |

Nothing was dropped, the container was never killed, and it used 6.6 MB of disk. A second run ingested the same mix for 15 minutes (4,485 request traces, about 450 turns, 16,000 spans, and 180 events): memory peaked at 73 MiB while ingesting and 131 MiB while searching, and settled at 95 MiB; the data took about 4.5 MB beyond OpenObserve’s 5.8 MB metadata database, roughly 300 bytes a span. `pnpm test:telemetry --browser`, which also restarts OpenObserve and replays its write-ahead log, peaked at 266 MiB. In the measurement runs the data was still in OpenObserve’s write-ahead and pending files, so moving it into long-term storage and compacting it, which happen later, were not measured. At that rate 5Gi holds on the order of 15 million spans, a week of about 25 spans a second, far more than one installation’s requests and teammate work produce once the browser’s polling is sampled. With OpenObserve’s defaults (still limited to 1 CPU), the same workload peaked at 245 MiB with unbounded caches and the GeoIP databases it downloads loaded; on a larger node, its defaults grow further. These are low-volume measurements on one machine, not a sizing guarantee: memory grows with concurrent searches, wide time ranges, and compaction of larger files, and disk grows with volume. The browser’s polling adds little, since quick successful reads are sampled at 5%.

## Operator access

OpenObserve is reachable only inside the cluster. To inspect it directly, for example for unowned background warnings:

```sh
kubectl -n <namespace> port-forward statefulset/openobserve 5080:5080
kubectl -n <namespace> get secret telemetry-credentials -o jsonpath='{.data.password}' | base64 -d
# Basic auth as everything@telemetry.local; stream "everything", types logs and traces.
curl -u "everything@telemetry.local:$PASSWORD" -H 'content-type: application/json' \
  'http://127.0.0.1:5080/api/default/_search?type=logs' \
  -d '{"query":{"sql":"SELECT * FROM \"everything\" ORDER BY _timestamp DESC","start_time":…,"end_time":…,"from":0,"size":50}}'
```

The web UI is turned off; set `ZO_UI_ENABLED` to `"true"` in a values override to use it through the port-forward.

## Testing

| Command | Covers |
| --- | --- |
| `pnpm --filter @everything/everything test` | Redaction (including nested causes, span events, log attributes, and credentials in URL paths, raw and percent-encoded), failure classification and retries diagnosed from their final attempt, the query builder’s scoping and escaping, the query service and API (validation, owner isolation, uniform 404s, ranges, cursors), the span pipeline (attribution, read filtering, allowlist, bounded queues, cancellation by error type only), real Pi sessions failing before and after HTTP 200 and being stopped, a fork’s message queued behind a user’s turn getting its own trace, error text withheld and recorded on every surface with natural-language canaries, and a real process started with the preload in both error-text modes: incoming HTTP, `fetch`, and PostgreSQL spans, telemetry turned off, and an unreachable backend. |
| `pnpm test:telemetry` | A disposable OpenObserve container run with the chart’s image, settings, and limits: both architectures are published, records exported by Everything’s runtime are searchable through the owner-scoped API with their trace, other owners’ records stay hidden, OpenObserve’s backslash escaping, paging, persistence across a restart, and the effective retention. CI runs it on every push. |
| `pnpm test:telemetry --browser` | The same, plus the page in Chromium against the real gateway and storage. Needs Playwright’s Chromium (`pnpm --filter @everything/ui-tests exec playwright install chromium`). |
| `pnpm --filter @everything/ui-tests test:telemetry` | The page against an isolated UI server with a mocked API: navigation order, phone layout, direct loads, filters, keyboard use, details, trace view, paging, newer-record announcements, Refresh of an unchanged custom range, traces that fill in later or fail and are retried, withheld error text, and empty, turned-off, and unavailable states. |

## License

OpenObserve is licensed under the AGPL-3.0. Everything runs its published image unchanged as a separate service and talks to it over its HTTP API; no OpenObserve code is copied into, linked with, or modified by Everything, and its web UI isn’t used. The OpenTelemetry JavaScript packages Everything uses are Apache-2.0.
