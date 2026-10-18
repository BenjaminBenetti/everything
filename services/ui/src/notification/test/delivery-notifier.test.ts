import assert from "node:assert/strict";
import { test } from "node:test";
import type { Agent } from "@everything/agent-contracts";
import type { ChatMessage } from "@everything/conversation-contracts";
import type { Update } from "@everything/update-contracts";
import {
  FakeDesktopNotifications,
  MemoryStorage,
  serialLocks,
  settle,
} from "../fixture/browser-fakes.js";
import { DeliveryNotifier } from "../service/delivery-notifier.js";
import { NotificationAttention } from "../service/notification-attention.js";
import {
  NotificationClaims,
  type NotificationClaimStore,
} from "../service/notification-claims.js";

const avery = { id: "avery", name: "Avery", avatarId: "avatar-03" } as Agent;
const blake = { id: "blake", name: "Blake", avatarId: "avatar-05" } as Agent;
const agents = [avery, blake];

/** A server time a whole number of seconds after a fixed start. */
function second(value: number): string {
  return new Date(Date.UTC(2026, 9, 17, 9, 0, value)).toISOString();
}

/** An unread message update; its message ID is what an open chat would report. */
function update(
  messageId: string,
  delivered: number,
  agentId = "avery",
  summary = `Summary of ${messageId}`,
): Update {
  return {
    id: `update-${messageId}`,
    kind: "message",
    agentId,
    messageId,
    summary,
    summaryStatus: "pending",
    createdAt: second(delivered),
  };
}

/** A message in a chat's latest page. */
function message(
  id: string,
  delivered: number,
  role: ChatMessage["role"] = "assistant",
  text = `Reply ${id}`,
): ChatMessage {
  return { id, role, text, createdAt: second(delivered) };
}

/** Claims that wait until the test releases them, like a busy cross-tab lock. */
class DeferredClaims implements NotificationClaimStore {
  private readonly pending: (() => void)[] = [];
  claim(): Promise<boolean> {
    return new Promise((resolve) => this.pending.push(() => resolve(true)));
  }
  release(): void {
    this.pending.splice(0).forEach((resolve) => resolve());
  }
}

/** One tab's notifier with a controllable clock, attention, and claims. */
function tab(
  options: {
    claims?: NotificationClaimStore;
    storage?: MemoryStorage;
    attending?: (agentId: string) => boolean;
  } = {},
) {
  let clock = 1_000;
  const notifications = new FakeDesktopNotifications();
  const opened: string[] = [];
  const attended = new Set<string>();
  const openChats = new Set<string>();
  const storage = options.storage ?? new MemoryStorage();
  const notifier = new DeliveryNotifier({
    notifications,
    claims:
      options.claims ??
      new NotificationClaims(
        () => storage,
        null,
        () => clock,
      ),
    attending: options.attending ?? ((agentId) => attended.has(agentId)),
    open: (path) => opened.push(path),
    now: () => clock,
  });
  return {
    notifier,
    notifications,
    opened,
    attended,
    /** Observe a feed page fetched now. */
    feed: (updates: Update[]) => {
      clock += 1;
      return notifier.observeFeed(updates, clock, agents);
    },
    /** Observe a chat's latest page fetched now, opening the chat on first use. */
    chat: (agent: Agent, messages: ChatMessage[]) => {
      if (!openChats.has(agent.id)) {
        notifier.openConversation(agent.id);
        openChats.add(agent.id);
      }
      clock += 1;
      return notifier.observeConversation(agent, messages, clock);
    },
    /** Close a chat, as leaving its page does. */
    close: (agentId: string) => {
      notifier.forgetConversation(agentId);
      openChats.delete(agentId);
    },
    /** Advance the clock and return the new time. */
    later: () => (clock += 1),
    titles: () =>
      notifications.shown.map(
        ({ content }) => `${content.title}: ${content.body}`,
      ),
  };
}

// ===========================================
// Activation and baselines
// ===========================================

test("nothing shows while notifications are off, and turning them on replays nothing", async () => {
  const browser = tab();
  await browser.feed([update("m1", 1)]);
  await browser.chat(avery, [message("r1", 1)]);
  await browser.chat(avery, [message("r1", 1), message("r2", 2)]);
  assert.deepEqual(browser.titles(), []);
  browser.notifier.activate();
  await browser.feed([update("m1", 1)]);
  await browser.chat(avery, [message("r1", 1), message("r2", 2)]);
  assert.deepEqual(browser.titles(), []);
  await browser.chat(avery, [
    message("r1", 1),
    message("r2", 2),
    message("r3", 3),
  ]);
  assert.deepEqual(browser.titles(), ["Avery: Reply r3"]);
});

test("the first feed check after turning on is the baseline, and a page cached from before is ignored", async () => {
  const browser = tab();
  browser.notifier.activate();
  // A page fetched before activation, such as one still in the query cache.
  await browser.notifier.observeFeed([update("m0", 0)], 0, agents);
  await browser.feed([update("m1", 1), update("m0", 0)]);
  assert.deepEqual(browser.titles(), []);
  await browser.feed([update("m2", 2), update("m1", 1), update("m0", 0)]);
  assert.deepEqual(browser.titles(), ["Avery: Summary of m2"]);
});

test("turning notifications off and on again doesn't replay what arrived while they were off", async () => {
  const browser = tab();
  browser.notifier.activate();
  await browser.feed([update("m1", 1)]);
  browser.notifier.deactivate();
  await browser.feed([update("m2", 2), update("m1", 1)]);
  browser.notifier.activate();
  await browser.feed([update("m2", 2), update("m1", 1)]);
  assert.deepEqual(browser.titles(), []);
  await browser.feed([update("m3", 3), update("m2", 2), update("m1", 1)]);
  assert.deepEqual(browser.titles(), ["Avery: Summary of m3"]);
});

// ===========================================
// Content and clicks
// ===========================================

test("a new delivery names the teammate, previews it as plain text, and opens its message", async () => {
  const browser = tab();
  browser.notifier.activate();
  await browser.feed([]);
  await browser.feed([
    update(
      "m/1",
      1,
      "avery",
      "**Ready** for review: [the plan](https://example.com) <b>today</b>",
    ),
  ]);
  const [shown] = browser.notifications.shown;
  assert.equal(shown?.content.title, "Avery");
  assert.equal(shown?.content.body, "Ready for review: the plan today");
  assert.equal(shown?.content.tag, "everything-message-m/1");
  assert.equal(shown?.content.icon, "/teammate-avatars/avatar-03.webp");
  browser.notifications.click(0);
  assert.deepEqual(browser.opened, ["/team/avery?message=m%2F1"]);
  assert.equal(shown?.closed, true);
});

test("an unknown teammate and an unreadable preview still give a useful notification", async () => {
  const browser = tab();
  browser.notifier.activate();
  await browser.feed([]);
  await browser.feed([update("m1", 1, "casey", "<br>")]);
  const [shown] = browser.notifications.shown;
  assert.equal(shown?.content.title, "Teammate");
  assert.equal(shown?.content.body, "Sent you a message.");
  assert.equal(shown?.content.icon, "/brand/icon-192.png");
});

test("many deliveries at once, such as after reconnecting, become one notification", async () => {
  const browser = tab();
  browser.notifier.activate();
  await browser.feed([]);
  await browser.feed([
    update("m5", 5, "blake"),
    update("m4", 4),
    update("m3", 3, "blake"),
    update("m2", 2),
  ]);
  assert.deepEqual(browser.titles(), [
    "Everything: 4 new messages from your teammates.",
  ]);
  browser.notifications.click(0);
  assert.deepEqual(browser.opened, ["/updates"]);

  await browser.chat(avery, []);
  await browser.chat(
    avery,
    [6, 7, 8, 9].map((delivered) => message(`r${delivered}`, delivered)),
  );
  assert.equal(browser.titles()[1], "Avery: Sent you 4 new messages.");
  browser.notifications.click(1);
  assert.equal(browser.opened[1], "/team/avery?message=r6");
});

test("up to three deliveries at once notify individually, oldest first", async () => {
  const browser = tab();
  browser.notifier.activate();
  await browser.feed([]);
  await browser.feed([
    update("m3", 3, "blake"),
    update("m2", 2),
    update("m1", 1),
  ]);
  assert.deepEqual(browser.titles(), [
    "Avery: Summary of m1",
    "Avery: Summary of m2",
    "Blake: Summary of m3",
  ]);
});

// ===========================================
// Replay and reconnection
// ===========================================

test("older unread updates moving onto the first page after newer ones are read never notify", async () => {
  const browser = tab();
  browser.notifier.activate();
  await browser.feed([update("m60", 60), update("m59", 59), update("m58", 58)]);
  // The user reads the newest updates elsewhere; older unread ones take their place.
  await browser.feed([update("m12", 12), update("m11", 11), update("m10", 10)]);
  await browser.feed([update("m9", 9)]);
  assert.deepEqual(browser.titles(), []);
  await browser.feed([update("m61", 61), update("m9", 9)]);
  assert.deepEqual(browser.titles(), ["Avery: Summary of m61"]);
});

test("reconnecting shows only what arrived while offline, and repeating the page shows nothing", async () => {
  const browser = tab();
  browser.notifier.activate();
  await browser.feed([update("m1", 1)]);
  // Checks fail while offline, so nothing is observed until the connection returns.
  await browser.feed([update("m3", 3), update("m2", 2), update("m1", 1)]);
  assert.deepEqual(browser.titles(), [
    "Avery: Summary of m2",
    "Avery: Summary of m3",
  ]);
  await browser.feed([update("m3", 3), update("m2", 2), update("m1", 1)]);
  await browser.feed([update("m3", 3), update("m2", 2), update("m1", 1)]);
  assert.equal(browser.notifications.shown.length, 2);
});

test("an open chat's history and the user's own messages never notify", async () => {
  const browser = tab();
  browser.notifier.activate();
  const history = [message("r1", 1), message("u1", 2, "user")];
  await browser.chat(avery, history);
  await browser.chat(avery, [...history, message("u2", 3, "user")]);
  assert.deepEqual(browser.titles(), []);
  await browser.chat(avery, [
    ...history,
    message("u2", 3, "user"),
    message("r2", 4),
  ]);
  assert.deepEqual(browser.titles(), ["Avery: Reply r2"]);
});

test("returning to a chat ignores its cached page, and the first fresh page is the baseline even with replies delivered while it was closed", async () => {
  const browser = tab();
  browser.notifier.activate();
  await browser.feed([]);
  // The query cache still holds the page from the previous visit.
  const cachedAt = browser.later();
  browser.later();
  browser.notifier.openConversation("avery");
  await browser.notifier.observeConversation(
    avery,
    [message("r1", 1)],
    cachedAt,
  );
  // The fresh page also has replies delivered while the chat was closed: history, not news.
  await browser.notifier.observeConversation(
    avery,
    [message("r1", 1), message("r2", 2), message("r3", 3)],
    browser.later(),
  );
  assert.deepEqual(browser.titles(), []);
  await browser.notifier.observeConversation(
    avery,
    [message("r1", 1), message("r2", 2), message("r3", 3), message("r4", 4)],
    browser.later(),
  );
  assert.deepEqual(browser.titles(), ["Avery: Reply r4"]);
});

test("a page that arrives after its chat closed is ignored", async () => {
  const browser = tab();
  browser.notifier.activate();
  await browser.chat(avery, [message("r1", 1)]);
  browser.close("avery");
  await browser.notifier.observeConversation(
    avery,
    [message("r1", 1), message("r2", 2)],
    browser.later(),
  );
  assert.deepEqual(browser.titles(), []);
});

test("reopening a chat starts a new baseline instead of replaying its history", async () => {
  const browser = tab();
  browser.notifier.activate();
  await browser.chat(avery, [message("r1", 1)]);
  browser.close("avery");
  await browser.chat(avery, [message("r1", 1), message("r2", 2)]);
  assert.deepEqual(browser.titles(), []);
});

// ===========================================
// The feed and an open chat together
// ===========================================

test("a reply the open chat marks read before the feed sees it still notifies, even if the chat opened before notifications were on", async () => {
  const browser = tab();
  await browser.chat(avery, [message("r1", 1)]);
  browser.notifier.activate();
  await browser.feed([]);
  await browser.chat(avery, [
    message("r1", 1),
    message("r2", 2, "assistant", "The *report* is ready"),
  ]);
  // The open chat's receipt means the feed never lists r2.
  await browser.feed([]);
  assert.deepEqual(browser.titles(), ["Avery: The report is ready"]);
});

test("a chat opened after the feed's baseline notifies its first reply", async () => {
  const browser = tab();
  browser.notifier.activate();
  await browser.feed([update("m1", 1)]);
  await browser.chat(avery, [message("m1", 1)]);
  await browser.chat(avery, [message("m1", 1), message("m2", 2)]);
  await browser.feed([update("m1", 1)]);
  assert.deepEqual(browser.titles(), ["Avery: Reply m2"]);
});

test("the feed and the open chat claim a message by the same message ID, in either order", async () => {
  const feedFirst = tab();
  feedFirst.notifier.activate();
  await feedFirst.feed([]);
  await feedFirst.chat(avery, []);
  await feedFirst.feed([update("m1", 1)]);
  await feedFirst.chat(avery, [message("m1", 1)]);
  assert.deepEqual(feedFirst.titles(), ["Avery: Summary of m1"]);

  const chatFirst = tab();
  chatFirst.notifier.activate();
  await chatFirst.feed([]);
  await chatFirst.chat(avery, []);
  await chatFirst.chat(avery, [message("m1", 1)]);
  await chatFirst.feed([update("m1", 1)]);
  assert.deepEqual(chatFirst.titles(), ["Avery: Reply m1"]);

  const together = tab();
  together.notifier.activate();
  await together.feed([]);
  await together.chat(avery, []);
  await Promise.all([
    together.feed([update("m1", 1)]),
    together.chat(avery, [message("m1", 1)]),
  ]);
  assert.equal(together.notifications.shown.length, 1);
});

// ===========================================
// Attention
// ===========================================

test("replies the user is looking at are skipped and stay handled, while other teammates still notify", async () => {
  const browser = tab();
  browser.notifier.activate();
  await browser.feed([]);
  await browser.chat(avery, []);
  browser.attended.add("avery");
  await browser.feed([update("m2", 2, "blake"), update("m1", 1)]);
  assert.deepEqual(browser.titles(), ["Blake: Summary of m2"]);
  // Looking away afterward doesn't bring back the reply the user already saw.
  browser.attended.clear();
  await browser.chat(avery, [message("m1", 1)]);
  assert.deepEqual(browser.titles(), ["Blake: Summary of m2"]);
});

test("an open chat in a hidden or unfocused tab notifies", async () => {
  const storage = new MemoryStorage();
  let visible = false;
  let focused = true;
  const attention = new NotificationAttention(
    () => storage,
    { visible: () => visible, focused: () => focused },
    () => 1_000,
    "this-tab",
  );
  attention.show("avery");
  const browser = tab({
    storage,
    attending: (agentId) => attention.attending(agentId),
  });
  browser.notifier.activate();
  await browser.chat(avery, []);
  await browser.chat(avery, [message("r1", 1)]);
  visible = true;
  focused = false;
  await browser.chat(avery, [message("r1", 1), message("r2", 2)]);
  focused = true;
  await browser.chat(avery, [
    message("r1", 1),
    message("r2", 2),
    message("r3", 3),
  ]);
  assert.deepEqual(browser.titles(), ["Avery: Reply r1", "Avery: Reply r2"]);
});

test("looking at a chat closes its notifications, and turning notifications off closes the rest", async () => {
  const browser = tab();
  browser.notifier.activate();
  await browser.feed([]);
  await browser.feed([update("m2", 2, "blake"), update("m1", 1)]);
  browser.notifier.attend("avery");
  assert.deepEqual(
    browser.notifications.shown.map(({ closed }) => closed),
    [true, false],
  );
  browser.notifier.deactivate();
  assert.deepEqual(
    browser.notifications.shown.map(({ closed }) => closed),
    [true, true],
  );
});

test("after many deliveries, turning notifications off or signing out still leaves none open", async () => {
  const browser = tab();
  browser.notifier.activate();
  await browser.feed([]);
  const page: Update[] = [];
  for (let delivered = 1; delivered <= 25; delivered++) {
    page.unshift(
      update(`m${delivered}`, delivered, delivered % 2 ? "avery" : "blake"),
    );
    await browser.feed([...page]);
  }
  const open = () =>
    browser.notifications.shown.filter(({ closed }) => !closed).length;
  assert.equal(browser.notifications.shown.length, 25);
  // Only the newest 20 stay open; older ones close as new ones arrive.
  assert.equal(open(), 20);
  assert.ok(
    browser.notifications.shown.slice(0, 5).every(({ closed }) => closed),
  );
  browser.notifier.attend("avery");
  assert.ok(
    browser.notifications.shown
      .filter(({ content }) => content.title === "Avery")
      .every(({ closed }) => closed),
  );
  browser.notifier.deactivate();
  assert.equal(open(), 0);
});

// ===========================================
// Pending claims across changes
// ===========================================

test("a claim that finishes after notifications were turned off and on again shows nothing", async () => {
  const claims = new DeferredClaims();
  const browser = tab({ claims });
  browser.notifier.activate();
  await browser.feed([]);
  const pending = browser.feed([update("m1", 1)]);
  browser.notifier.deactivate();
  browser.notifier.activate();
  claims.release();
  await pending;
  assert.deepEqual(browser.titles(), []);

  await browser.feed([update("m1", 1)]);
  const next = browser.feed([update("m2", 2), update("m1", 1)]);
  await settle();
  claims.release();
  await next;
  assert.deepEqual(browser.titles(), ["Avery: Summary of m2"]);
});

test("a claim that finishes after sign-out never shows the previous user's message", async () => {
  const claims = new DeferredClaims();
  const browser = tab({ claims });
  browser.notifier.activate();
  await browser.chat(avery, []);
  const pending = browser.chat(avery, [
    message("r1", 1, "assistant", "Private salary details"),
  ]);
  // Signing out deactivates; even if notifications were active again for the next user, the
  // earlier delivery belongs to a previous activation.
  browser.notifier.deactivate();
  browser.notifier.activate();
  claims.release();
  await pending;
  assert.deepEqual(browser.notifications.shown, []);
});

// ===========================================
// Failures and side effects
// ===========================================

test("a notification the browser refuses is reported, and the next one shown clears it", async () => {
  const browser = tab();
  let changes = 0;
  browser.notifier.subscribe(() => changes++);
  browser.notifier.activate();
  await browser.feed([]);
  browser.notifications.failShowing = true;
  await browser.feed([update("m1", 1)]);
  assert.equal(browser.notifier.deliveryFailed, true);
  assert.equal(changes, 1);
  browser.notifications.failShowing = false;
  await browser.feed([update("m2", 2), update("m1", 1)]);
  assert.equal(browser.notifier.deliveryFailed, false);
  assert.equal(changes, 2);
  assert.deepEqual(browser.titles(), ["Avery: Summary of m2"]);
});

test("observing deliveries changes nothing it observes and never navigates on its own", async () => {
  const browser = tab();
  browser.notifier.activate();
  const page = Object.freeze([Object.freeze(update("m1", 1))]);
  await browser.notifier.observeFeed(page, browser.later(), agents);
  await browser.notifier.observeFeed(
    Object.freeze([Object.freeze(update("m2", 2)), ...page]),
    browser.later(),
    agents,
  );
  const messages = Object.freeze([
    Object.freeze(message("r1", 3)),
  ]) as unknown as ChatMessage[];
  await browser.chat(avery, []);
  await browser.chat(avery, messages);
  assert.equal(browser.notifications.shown.length, 2);
  assert.deepEqual(browser.opened, []);
});

// ===========================================
// Several tabs
// ===========================================

test("several tabs notify about a message once, and a tab showing the chat silences the others", async () => {
  const storage = new MemoryStorage();
  const locks = serialLocks();
  const claims = () =>
    new NotificationClaims(
      () => storage,
      locks,
      () => 1_000,
    );
  const looking = { visible: true, focused: true };
  const attentionA = new NotificationAttention(
    () => storage,
    { visible: () => looking.visible, focused: () => looking.focused },
    () => 1_000,
    "tab-a",
  );
  const attentionB = new NotificationAttention(
    () => storage,
    { visible: () => false, focused: () => false },
    () => 1_000,
    "tab-b",
  );
  const first = tab({
    storage,
    claims: claims(),
    attending: (agentId) => attentionA.attending(agentId),
  });
  const second = tab({
    storage,
    claims: claims(),
    attending: (agentId) => attentionB.attending(agentId),
  });
  for (const browser of [first, second]) {
    browser.notifier.activate();
    await browser.feed([]);
  }
  await Promise.all([
    first.feed([update("m1", 1, "blake")]),
    second.feed([update("m1", 1, "blake")]),
  ]);
  assert.equal(
    first.notifications.shown.length + second.notifications.shown.length,
    1,
  );
  assert.ok(locks.names.every((name) => name === locks.names[0]));

  // Tab A shows Avery's chat in front of the user; tab B is in the background.
  attentionA.show("avery");
  attentionA.publish();
  await second.feed([update("m2", 2), update("m1", 1, "blake")]);
  await first.feed([update("m2", 2), update("m1", 1, "blake")]);
  assert.equal(
    first.notifications.shown.length + second.notifications.shown.length,
    1,
  );
});
