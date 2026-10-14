# Unread teammate updates

Updates and Home derive their feed from unread `assistant` rows in the visible `messages` table. These rows are the replies delivered to the owner by the main teammate. User messages, private fork messages, tool output, reasoning, and runtime status do not enter the feed. There is no second delivery queue to duplicate or reconcile.

Each update is identified by its source message ID and links to `/team/:agentId?message=:messageId`. The UI uses the existing chronological history pages to load and highlight that exact message. Home shows eight previews; Updates pages through all unread messages, newest first, in batches of 50. Summaries are deterministic, whitespace-normalized excerpts of the delivered Markdown, up to 280 characters, with common formatting removed. They do not make model calls or invent conclusions.

## Read behavior

The browser acknowledges individual assistant message IDs only after a message has occupied at least half its height (or half the visible conversation viewport for long messages) for at least 750 ms. The document must be visible and focused, with no open workspace dialog. Scrolling away, hiding or blurring the page, navigating away, and opening dialogs stop acknowledgement. The original message must load before an update link can consume it. Viewing the preview alone does not consume the update.

`GET /v1/updates?before=<messageId>` is a side-effect-free, authenticated, owner-scoped query. `POST /v1/agents/:agentId/messages/read` accepts `{ "messageIds": ["<uuid>"] }` with up to 100 unique IDs. It verifies and locks the owned teammate in the same transaction as the update. Only unread assistant messages belonging to that teammate are changed. Foreign message IDs cannot acknowledge another teammate's history; missing and inaccessible teammate IDs both return 404. Already acknowledged IDs are idempotent. Exact IDs preserve unseen gaps and messages delivered concurrently with a receipt.

The migration adds nullable `messages.read_at` and a partial unread index. It baselines pre-migration messages as read because previous visibility was never recorded. New visible replies start unread. The first successful receipt persists a server timestamp; later receipts cannot clear or change it. Receipts survive process restarts, navigation, reloads, and multiple clients. Teammate deletion cascades to both messages and their receipts.

The feed polls every five seconds while visible, refreshes on return/reconnect, and invalidates after local receipts. Another client's receipts are reflected on the next fetch. Failed receipt writes remain unread and retry while the message is visible, with status feedback. The server trusts the authenticated browser's explicit receipt; it cannot verify human attention.

## Limits and assumptions

- Updates is an unread inbox. Read messages remain in the original conversation and leave the feed.
- This introduces in-app updates only. Push delivery, OS notification permissions, and model-generated digests remain separate work.
- Earlier read history cannot be reconstructed. The rollout does not create a historical backlog.
- Old message links may fetch multiple history pages. This retains the existing conversation API and behavior, at the cost of extra requests for very old messages.
- Exposure is a practical read proxy, not proof that the human read every word. A reply can appear briefly in another client's feed before the viewing client saves its receipt.

## Verification

Run `pnpm build`, `pnpm test`, and `pnpm format:check`. To include the PostgreSQL integration test, point `UPDATES_TEST_DATABASE_URL` at a **test** PostgreSQL server whose user can create databases; the test creates and removes a randomly named database for each run. For example:

```sh
UPDATES_TEST_DATABASE_URL=postgresql://updates_test:updates_test@127.0.0.1:55432/everything_updates_test pnpm --filter @everything/everything test
```

The integration test runs the pre-feature migrations, inserts historical data, upgrades it, then checks baseline behavior, pagination, exact receipts, ownership, concurrent delivery, idempotency, connection recreation, and cascade deletion. Without the variable it is explicitly skipped. API unit tests validate receipt payloads and excerpt summaries. Existing runtime tests continue to cover the private fork/public delivery boundary.

With the UI dev server running, the browser tests use controlled API state and the production React UI:

```sh
UI_TEST_ORIGIN=http://localhost:5173 pnpm --filter @everything/ui-tests test:browser src/update/test/updates.test.ts src/conversation/test/conversation.test.ts
```

They run on desktop and phone viewports and cover delivery while looking/away, visibility and focus changes, a response completing after hiding the tab, scrolling, dialogs, old message links, reloads, pagination, receipt failure/retry, history reconnects, and a second browser context. Document attention events are controlled explicitly because headless Chromium does not consistently emulate OS window focus. Screenshot evidence is saved under `.local/ui-test-results`.
