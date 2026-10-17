# Desktop notifications

Everything can show a desktop browser notification when a teammate sends you a message. It's for desktop browsers only; phones and tablets show the existing Home Screen steps and never ask for permission. There's no push service, service-worker notification, or Web Push subscription, so notifications appear only while an Everything tab is open, including in the background.

## Turning them on

The topbar's Notification settings button (the same item in the phone's workspace menu) opens **Notifications**. Its Desktop section tells the user to keep an Everything tab open to get notifications while using another tab or app, and that notifications stop when all Everything tabs are closed. Its **Desktop notifications** switch is off by default and saved per signed-in user on this device, in browser storage like the color theme. Other tabs follow changes immediately. If storage refuses the choice (private windows, a full or read-only storage area), it still applies on that page until it closes or another tab saves a newer one.

The browser is asked for permission only when the user turns the switch on, from that click. Page loads, arriving messages, reloads, and other automatic effects never ask. The switch is on only while the user's choice is on **and** the browser allows notifications. The text under the switch matches the current state:

| State                                                                                  | Switch   | Explanation                                                                  |
| -------------------------------------------------------------------------------------- | -------- | ---------------------------------------------------------------------------- |
| No Notifications API, an insecure page, or a phone or tablet (including iPads)         | Disabled | This browser can't show desktop notifications; use a desktop browser.        |
| Not yet decided                                                                        | Off      | The browser will ask when you turn this on.                                  |
| Waiting for the prompt                                                                 | Disabled | Choose Allow in the browser's prompt.                                        |
| Prompt dismissed                                                                       | Off      | The browser didn't allow notifications; turn the switch on to ask again.     |
| Asking failed                                                                          | Off      | The browser couldn't ask; try again or allow it in site settings.            |
| Blocked                                                                                | Disabled | Allow notifications for this site in the browser's settings.                 |
| Allowed, switch off                                                                    | Off      | The browser allows them, but Everything won't send any on this device.       |
| On                                                                                     | On       | Notifies when a teammate sends a message, unless you're looking at the chat. |
| On, but the browser refused to create the last notification (for example, OS settings) | On       | Check that your computer allows notifications from the browser.              |

Permission changes made in browser settings are picked up through the Permissions API and whenever the window regains focus.

## What notifies

Only messages a teammate delivers to the user notify: the same messages that become `message` updates. User messages, tool output, reasoning, runtime status, private forks, and other update kinds never notify. Deliveries are observed in two places:

- **The unread update feed.** While notifications are on, every signed-in tab checks the first page of `GET /v1/updates` every five seconds, including in background tabs. Nothing extra is requested while they're off.
- **An open chat.** A chat that's open marks new replies read as soon as they arrive, even in a hidden tab, so the feed may never list them. The open chat reports its own new replies directly.

Each place takes the first page it fetches after starting as its baseline: the feed after notifications are turned on, and a chat after it opens. A page fetched earlier, such as one still cached from before notifications were turned off or the history shown on returning to a teammate, is ignored. Messages in the baseline don't notify, so existing history, messages delivered while notifications were off or the chat was closed, and messages delivered before the page loaded never notify there.

After the baseline, an item is new only if it was delivered after the newest one already seen, or at that same instant without having been seen (a server-time high-water mark). Older unread updates that move onto the first page after newer ones are read therefore never notify, and a page repeated after reconnecting doesn't notify anything already observed. Messages delivered after the baseline that the tab hadn't observed yet, for example while it was offline, do notify once checks succeed again, combined into one notification when there are more than three. Turning notifications off resets the feed's baseline.

Both places identify a message by its message ID. Before showing anything, a tab claims that ID, so each message notifies once across both places. Claims are shared with the browser's other tabs through browser storage, under a Web Locks lock that makes each claim atomic, so with both available a message notifies once in the whole browser. Coordination across tabs is best effort otherwise: without the Web Locks API, two tabs checking at the same moment could both notify; without usable storage, each tab deduplicates only its own observations, and several open tabs can each notify. Each notification uses the message ID as its `tag`, so most browsers replace such a duplicate instead of stacking it.

More than three new messages in one check (for example after reconnecting) become one notification: "Sent you N new messages." when they're from one teammate, or "N new messages from your teammates." otherwise.

Each signed-in user gets separate notification state. A tab keeps at most 20 of its notifications open, closing the oldest as new ones arrive, so it can always close all of them. Signing out or turning notifications off closes the tab's notifications, and a delivery whose claim finishes after either change is dropped, so nothing from one activation or account appears in another.

## While you're looking

A message isn't shown when its teammate's chat is open in a tab that is visible **and** focused, in this tab or another one. The message is still claimed, so it doesn't notify later. Everything else notifies normally: other teammates' messages while you use Everything, and replies in an open chat whose tab is hidden or whose window doesn't have focus. A tab showing a chat shares that in browser storage, renewing it every three seconds; other tabs ignore a record older than ten seconds, such as one left by a crashed tab. Without usable storage, other tabs can't see it and may notify about a chat the user is looking at elsewhere. Looking at a chat also closes that tab's notifications about it.

## Content and clicks

The title is the teammate's name ("Teammate" if it hasn't loaded) and the icon is their avatar. The body is a plain-text preview of the update's summary or preview, or of the reply text: Markdown syntax and HTML tags are removed (link text and image descriptions remain), control and bidirectional-override characters are dropped, whitespace collapses, and it's clamped to 140 characters on a word boundary. An empty result reads "Sent you a message."

Notification text comes only from content the user can already see in Everything: the teammate's name, and the update's summary or preview or the delivered reply text. It never includes session or authentication data, request or response details, update or message IDs, a teammate's instructions, tool output, private fork output, or other runtime data. Link destinations and image addresses are removed. The preview does repeat what the teammate wrote, so it's as private as the message; operating systems may show it on screen or on the lock screen according to their notification settings.

Clicking a notification focuses its tab and opens `/team/:agentId?message=:messageId`, the same link an update card uses, which highlights the message and loads earlier history when needed. A summary of several messages opens that teammate's oldest new message, or Updates. Notifications never send read receipts: a message still becomes read only through the chat's usual rules, and unread counts are unchanged.

## Limits

- Notifications need an open Everything tab. Browsers slow timers in long-hidden tabs, so a background notification can take up to about a minute.
- A notification can't be clicked after the tab that created it closes, and only that tab can close it.
- Messages delivered before the page loaded or before notifications were turned on don't notify; the Updates feed and badges still show them.
- Only the newest 50 unread updates, the feed's first page, are checked. If more than 50 arrive between checks, the combined notification counts only those 50 and the older ones from that gap don't notify; all of them still appear in Updates.
- In the rare case that two deliveries commit out of order between two checks, the earlier one may not notify; it still appears in Updates.
- Mobile notifications need push delivery and aren't available yet.

## Verification

Unit tests in `src/notification/test` cover the preview, the high-water mark, permission and support detection, the preference, cross-tab claims and attention, the status text, and the notifier's activation, baselines (including cached pages), deduplication, foreground handling, bursts, failures, and pending claims across turning off and signing out. Run `pnpm --filter @everything/ui-service test`.

The browser suite in `testing/ui/src/notification/test/desktop-notifications.test.ts` replaces the API and the Notifications API, so it runs against the Vite dev server without a cluster:

```sh
pnpm --filter @everything/ui-service dev
UI_TEST_ORIGIN=http://localhost:5173 pnpm --filter @everything/ui-tests test:browser src/notification/test/desktop-notifications.test.ts
```

It checks that permission is requested only from the switch, that the choice survives reloads, dismissed and blocked states, that phones never ask, background delivery without replay or receipts, click routing, open-chat replies in hidden and focused tabs, returning to a chat without replaying replies delivered while it was closed, and two tabs notifying once. Real operating-system notification display, sounds, and click focus need a manual check in each desktop browser.
