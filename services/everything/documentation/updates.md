# Unread teammate updates

Updates and Home derive their feed from unread `assistant` rows in the visible `messages` table. These rows are the replies delivered to the owner by the main teammate. User messages, private fork messages, tool output, reasoning, and runtime status do not enter the feed. There is no second delivery queue to duplicate or reconcile.

Each update is identified by its source message ID and links to `/team/:agentId?message=:messageId`. The UI uses the existing chronological history pages to load and highlight that exact message. Home shows eight previews; Updates pages through all unread messages, newest first, in batches of 50. Summaries are generated with a real model call and cached on the message, up to 280 characters. The request uses the teammate's current saved provider/model through `PiInferenceRuntimeFactory`, with the owner's credentials, minimal reasoning effort, a 2,048-token output cap (or the model's lower limit), a 30-second inference timeout, and no SDK retries. It makes no Pi session, loads no conversation history or private fork data, has no tools, and sends only a fixed summarization instruction plus the public source message. The prompt asks for the main result, question or action, preserving uncertainty and identifiers. Model output is treated as plain text in the UI.

## Summary generation

The singleton API runs a summary scheduler independently of browser requests. Every five seconds it discovers up to ten unread public replies at least 1.5 seconds old, giving active readers a chance to acknowledge delivery first. At most two requests run concurrently. Claiming a message rechecks its owner and unread state transactionally, then persists `summary_status = 'generating'` and `summary_started_at` before making the external call. Concurrent workers cannot claim the same message twice. Only the claim winner can save `update_summary` and the final ready/failed state. Read receipts and conversation messages are unchanged by generation.

Pending jobs survive restarts. Completed summaries and failures are durable, so feed polling, reconnects, multiple clients, and restarts do not repeat paid inference. A failed request is not automatically retried, since the provider may have processed it before the connection failed. A claimed request interrupted by a process crash is also not reissued; after two minutes without a result, the feed labels it unavailable. The original message remains accessible. This favors avoiding duplicate charges over automatically retrying ambiguous failures.

The feed labels successful results **AI summary**. Before completion it shows **Preparing summary · Message preview**; on a failure or abandoned attempt it shows **Summary unavailable · Message preview**. These previews are explicitly secondary fallbacks, using whitespace-normalized original text without interpreting Markdown or altering code/identifiers. A reply read before its claim does not incur a summary request. If it becomes read during inference, the result may finish and be cached but does not reappear in Updates. Summary calls can incur usage on the owner's configured provider.

## Read behavior

The browser acknowledges individual assistant message IDs only after a message has occupied at least half its height (or half the visible conversation viewport for long messages) for at least 750 ms. The document must be visible and focused, with no open workspace dialog. Scrolling away, hiding or blurring the page, navigating away, and opening dialogs stop acknowledgement. The original message must load before an update link can consume it. Viewing the preview alone does not consume the update.

`GET /v1/updates?before=<messageId>` is a side-effect-free, authenticated, owner-scoped query. `POST /v1/agents/:agentId/messages/read` accepts `{ "messageIds": ["<uuid>"] }` with up to 100 unique IDs. It verifies and locks the owned teammate in the same transaction as the update. Only unread assistant messages belonging to that teammate are changed. Foreign message IDs cannot acknowledge another teammate's history; missing and inaccessible teammate IDs both return 404. Already acknowledged IDs are idempotent. Exact IDs preserve unseen gaps and messages delivered concurrently with a receipt.

The migration adds nullable `messages.read_at`, cached summary text/status/attempt time, and partial indexes for unread messages and pending summary work. It baselines pre-migration messages as read because previous visibility was never recorded. New visible replies start unread. The first successful receipt persists a server timestamp; later receipts cannot clear or change it. Receipts survive process restarts, navigation, reloads, and multiple clients. Teammate deletion cascades to both messages and their receipts.

The feed polls every five seconds while visible, refreshes on return/reconnect, and invalidates after local receipts. Another client's receipts are reflected on the next fetch. Failed receipt writes remain unread and retry while the message is visible, with status feedback. The server trusts the authenticated browser's explicit receipt; it cannot verify human attention.

## Limits and assumptions

- Updates is an unread inbox. Read messages remain in the original conversation and leave the feed.
- This introduces in-app updates only. Push delivery, OS notification permissions, and summaries combining multiple messages remain separate work.
- Earlier read history cannot be reconstructed. The rollout does not create a historical backlog.
- Old message links may fetch multiple history pages. This retains the existing conversation API and behavior, at the cost of extra requests for very old messages.
- Exposure is a practical read proxy, not proof that the human read every word. A reply can appear briefly in another client's feed before the viewing client saves its receipt.

## Verification

Run `pnpm build`, `pnpm test`, and `pnpm format:check`. To include the PostgreSQL integration test, point `UPDATES_TEST_DATABASE_URL` at a **test** PostgreSQL server whose user can create databases; the test creates and removes a randomly named database for each run. For example:

```sh
UPDATES_TEST_DATABASE_URL=postgresql://updates_test:updates_test@127.0.0.1:55432/everything_updates_test pnpm --filter @everything/everything test
```

The integration test runs the pre-feature migrations, inserts historical data, upgrades it, then checks baseline behavior, pagination, exact receipts, ownership, concurrent delivery, idempotency, connection recreation, and cascade deletion. Without the variable it is explicitly skipped. API tests validate receipt payloads, isolated model requests with owner-specific credentials, provider failure/no-retry behavior, concurrent worker deduplication, shutdown, and labeled fallback states. Provider protocol responses are mocked; these tests do not claim live inference succeeded. Existing runtime tests continue to cover the private fork/public delivery boundary.

With the UI dev server running, the browser tests use controlled API state and the production React UI:

```sh
UI_TEST_ORIGIN=http://localhost:5173 pnpm --filter @everything/ui-tests test:browser src/update/test/updates.test.ts src/conversation/test/conversation.test.ts
```

They run on desktop and phone viewports and cover delivery while looking/away, visibility and focus changes, a response completing after hiding the tab, scrolling, dialogs, old message links, reloads, pagination, receipt failure/retry, history reconnects across disjoint pages, generated-summary/fallback labels, and a second browser context. Document attention events are controlled explicitly because headless Chromium does not consistently emulate OS window focus. Screenshot evidence is saved under `.local/ui-test-results`.

Screenshot evidence uses the running production UI with controlled API data and mocked model results. It demonstrates presentation and read behavior, not a live provider connection. No real owner credentials or private conversation data are used in the screenshots.
