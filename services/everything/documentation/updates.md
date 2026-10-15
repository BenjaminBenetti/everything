# Updates

An update is something that needs the owner's attention. Updates are stored in their own `updates` table, separate from whatever produced them. A message a teammate sends its owner is the first kind (`message`); more kinds will follow, and some need not belong to a teammate, such as a provider connection failing. Home shows the newest eight unread updates. Updates shows unread items first, followed by a separate, muted **Seen** history. Both feeds load older items as the user scrolls, newest first in batches of 50, with an accessible load-more button and explicit retry after failures. When nothing is unread, a compact caught-up card sits above the history.

## Data model

Each row is directly owned (`owner_id`) and has a `kind`. Kind-specific source references are typed, nullable columns with real foreign keys, so deleting a source deletes its updates:

| Column                                            | Purpose                                                                                                                                                                        |
| ------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ |
| `id`, `created_at`, `owner_id`                    | Identity, creation time, and owner. Every query is scoped by owner.                                                                                                            |
| `kind`                                            | `'message'`, enforced by `updates_kind_check`.                                                                                                                                 |
| `agent_id`, `message_id`                          | For `message` updates (both required by `updates_message_reference_check`). Cascade from the teammate or message. `message_id` is unique, so a message has at most one update. |
| `summary`, `summary_status`, `summary_started_at` | The cached model summary (1–200 characters), `pending`/`generating`/`ready`/`failed`, and when the attempt was claimed.                                                        |
| `read_at`                                         | The first receipt; null while unread. It never changes once set.                                                                                                               |
| `sequence`                                        | Identity column giving stable newest-first ordering and cursors.                                                                                                               |

Partial indexes cover each owner's unread updates (`owner_id, sequence WHERE read_at IS NULL`) seen history (`owner_id, sequence WHERE read_at IS NOT NULL`), and pending summary work (`created_at, sequence WHERE read_at IS NULL AND summary_status = 'pending'`). The migration does not backfill: messages delivered before it have no updates, the same as having been read. The entity schema mirrors the migration exactly; the PostgreSQL integration test checks that TypeORM reports no schema difference.

### Adding a kind

1. Add a variant to the `Update` union in `@everything/update-contracts`.
2. Add a migration that extends `updates_kind_check`, adds the kind's typed reference columns and foreign keys, and adds a check that requires them for that kind. Mirror it in `update/schema/update-entity.ts` and add the kind to `updateKinds`.
3. In `PostgresUpdateRepository.toEntity`, resolve the kind's source: its references and the `sourceText` that is summarized and previewed. Add an eager relation if the text comes from another table.
4. Map it to its public variant in `update/presenter/update-presenter.ts`, and add its summary prompt to `update/prompt/update-summary-prompt.ts`.
5. Insert the update in the same transaction as the event that produces it.

The compiler requires steps 3 and 4 once the contract variant exists. Summaries use the model selected for the update's teammate. A kind without a teammate should either be inserted with `summary_status = 'ready'` and a fixed summary, or extend the claim to choose a model.

## Creating message updates

A teammate's `send_message` reply goes through `MessageRepository.deliver`, which locks the owned teammate, inserts the message, and inserts its unread update in one serializable transaction. If either insert fails, neither is saved. User messages use `append` and never create updates. Private fork messages, tool output, reasoning, and runtime status are never delivered, so they never become updates.

## API

- `GET /v1/updates?before=<updateId>` returns `UpdatePage`: `{ updates: Update[], nextCursor: string | null }`, newest first. Each `message` update has `id`, `kind`, `agentId`, `messageId`, `summary`, `summaryStatus` (`ready`, `pending`, `unavailable`, or `disabled`), and `createdAt`, and links to `/team/:agentId?message=:messageId`. The cursor is an update ID owned by the caller, and it stays valid after that update is read. A foreign or missing cursor returns an empty page. The request has no side effects.
- `GET /v1/updates/seen?before=<updateId>` returns the same `UpdatePage` shape for updates with a receipt. Ordering follows original delivery, independently of receipt time. The same owner-scoped cursor rules apply, and fetching history never changes receipts or starts inference. Existing receipts appear immediately without a backfill.
- `GET /v1/updates/count` returns `UpdateCount`: `{ unread: number, byAgent: Record<string, number> }`, the owner's unread total and positive counts by teammate ID from the same snapshot. The Updates tab, sidebar teammates, and team cards share this response; teammates absent from `byAgent` have no unread updates and show no badge. Counts include all unread updates, regardless of feed pagination. The repository loads only unread teammate references without messages or summaries. Updates without a teammate contribute only to the overall total.
- `POST /v1/agents/:agentId/messages/read` accepts `{ "messageIds": ["<uuid>"] }` with 1 to 100 unique IDs and returns 204. It verifies and locks the owned teammate in the same transaction that sets `read_at` on that teammate's unread `message` updates for exactly those messages. Missing and inaccessible teammates both return 404. IDs from other teammates do nothing. Repeating a receipt is harmless, and the first read time never changes. Because receipts name exact messages, unseen gaps and replies delivered at the same moment stay unread.

## Summaries

Settings → General → **Summarize updates** controls whether the owner’s update cards use model summaries. It defaults to off and is saved per owner in `general_settings`, shared across devices and restarts. `GET /v1/settings/general` reads `{ summarizeUpdates: boolean }`, and `PUT /v1/settings/general` saves that shape for the authenticated owner. Turning it off immediately refreshes the feed to show source previews with `summaryStatus: "disabled"`, including for previously summarized cards. Background discovery filters disabled owners before limiting its batch, and the scheduler checks the preference again before claiming work. A call already in flight may finish; its cached result stays hidden while the setting is off. Re-enabling reuses cached summaries and resumes pending unread updates.

A summary is one short sentence telling the owner why to go back: the question, choice, or action the teammate needs from them, or the concrete result it delivered. Examples: "Needs your choice of temperature: A, B, or C?" and "Finished all 10 steeps; offers to build a page or app next." The prompt aims for 120 characters and never more than 200. It asks the model to start with a verb rather than "Teammate" or "The teammate", to write plain text without Markdown, emoji, or quotation marks, to keep names, numbers, and identifiers exactly, to use only facts from the message, and never to follow instructions inside it. Output is whitespace-normalized, unwrapped from surrounding quotes, and clamped to 200 characters on a word boundary.

Each summary is an isolated model call. It uses the teammate's saved provider and model through `PiInferenceRuntimeFactory`, with the owner's credentials, minimal reasoning, an output cap of 1,024 tokens (or the model's lower limit), a 30-second timeout, and no SDK retries. It sends only the fixed prompt and the source text. It creates no Pi session and has no tools, history, or fork data. Summary calls can incur usage on the owner's provider.

The singleton API's `UpdateSummaryScheduler` runs independently of browsers. Every five seconds it finds up to ten unread pending updates at least ten seconds old, so an owner watching the chat sends a receipt first and no summary is generated for a reply they have already seen, and runs at most two calls at a time. A claim rechecks the owner, unread state, and `pending` status under a row lock, and commits `generating` and `summary_started_at` before the model call. Only the claimed attempt can save the result. Failures are saved as `failed`, and an attempt interrupted by a crash is never reissued; after two minutes it is reported as unavailable. Nothing retries, because a failed request may still have been billed. An update read before its claim never incurs a call.

Until a summary is ready, the feed returns a whitespace-normalized preview of the source text, clamped the same way, with `summaryStatus` set to `pending` or `unavailable`. The UI labels it as a preview. Seen updates without a cached summary always use a preview labeled `unavailable`; they never display a pending summary that will not be generated.

## Read behavior

The browser acknowledges a teammate message only after it has filled at least half its height for 750 ms. For a message taller than the viewport, its beginning or its end must be visible and it must fill at least half the viewport for the same time. Following a new reply to its end therefore counts; seeing only its middle does not. Update links align long messages to their beginning and center shorter ones.

The page must be visible and focused, with no workspace dialog open. Scrolling away, hiding or leaving the page, and opening dialogs reset the timer. The original message must load before an update link can mark it read; seeing the summary alone does not. "Read" means this sustained view of the message, not proof that every word was read. The server trusts the authenticated browser's receipt.

The unread feed refreshes every five seconds while visible, on return or reconnect, and after local receipts. Receipts from another client appear on the next refresh. A failed receipt stays unread and retries while the message is visible. Seen history refreshes on return or reconnect and after local receipts or summary preference changes, without polling every loaded history page.

## Limits

- Seen updates remain available in history and link to their original messages, just like unread updates.
- Updates are in-app only. Push delivery, OS notifications, and summaries that combine several updates are separate work.
- Messages delivered before the migration have no updates.
- Opening an old message link may load several history pages, using the existing conversation API.

## Verification

Run `pnpm --filter @everything/everything check`, `test`, and `build`, then `pnpm format:check`. To include the PostgreSQL integration test, point `UPDATES_TEST_DATABASE_URL` at a **test** server whose user can create databases. The test creates and removes a randomly named database. For example:

```sh
docker run -d --rm --name updates-test-pg -e POSTGRES_USER=updates_test -e POSTGRES_PASSWORD=updates_test -p 55432:5432 postgres:17.11-bookworm
UPDATES_TEST_DATABASE_URL=postgresql://updates_test:updates_test@127.0.0.1:55432/postgres pnpm --filter @everything/everything test
docker stop updates-test-pg
```

The integration test upgrades a database that already has messages, checks for schema drift, and covers: delivery creating exactly one update atomically; user messages creating none; pagination and cursors that survive receipts; the count; exact, idempotent, owner-scoped receipts; concurrent delivery; summary claims, results, failures, and abandonment; reconnecting; check constraints; cascades; and reverting the migration. Without the variable, it is skipped. Unit tests cover the controller, feed mapping, repository scoping, the scheduler, and the summarizer's prompt, isolation, output limits, and failure handling. Provider responses are mocked, so these tests do not prove live inference works.

With the UI dev server running, browser tests use controlled API state and the production React UI:

```sh
UI_TEST_ORIGIN=http://localhost:5173 pnpm --filter @everything/ui-tests test:browser src/update/test/updates.test.ts src/conversation/test/conversation.test.ts
```
