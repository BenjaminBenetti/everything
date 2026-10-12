import { expect, test, type BrowserContext } from "@playwright/test";

interface Message {
  id: string;
  role: "user" | "assistant";
  text: string;
  createdAt: string;
}

/** Exercise the shipped chat UI with controllable replies and persisted server-side history. */
async function workspace(context: BrowserContext, withModel = true) {
  const state = {
    messages: Array.from({ length: 205 }, (_, index): Message => ({
      id: `message-${index + 1}`,
      role: index % 2 ? "assistant" : "user",
      text: `Saved message ${index + 1}`,
      createdAt: "2026-10-12T10:00:00Z",
    })),
    runtime: {
      status: "idle",
      compacting: false,
      sessionId: "private-session-id",
      runId: null as string | null,
      error: null as string | null,
    },
    failSend: false,
    failRead: false,
    sends: [] as string[],
    interruptions: 0,
  };
  await context.route("**/v1/session", (route) =>
    route.fulfill({
      json: {
        profile: { subject: "chat-test-owner", displayName: "Chat owner" },
      },
    }),
  );
  await context.route("**/v1/providers", (route) =>
    route.fulfill({ json: { providers: [] } }),
  );
  await context.route("**/v1/agents", (route) =>
    route.fulfill({
      json: {
        agents: ["Avery", "Blake"].map((name) => ({
          id: name.toLowerCase(),
          name,
          avatarId: "avatar-03",
          systemPrompt: "Help with project planning.",
          createdAt: "2026-10-12T10:00:00Z",
          inference: withModel
            ? {
                provider: "openai-compatible",
                model: "o3-mini",
                effort: "high",
              }
            : null,
        })),
      },
    }),
  );
  await context.route("**/v1/agents/*/runtime", (route) =>
    route.fulfill({
      json: route.request().url().includes("/avery/")
        ? state.runtime
        : { ...state.runtime, status: "idle", compacting: false },
    }),
  );
  await context.route("**/v1/agents/*/interrupt", (route) => {
    state.interruptions++;
    state.runtime.status = "idle";
    state.runtime.compacting = false;
    return route.fulfill({ json: state.runtime });
  });
  await context.route(
    /\/v1\/agents\/[^/]+\/messages(?:\?.*)?$/,
    async (route) => {
      const request = route.request();
      if (request.method() === "POST") {
        const { text } = request.postDataJSON() as { text: string };
        state.sends.push(text);
        if (state.failSend)
          return route.fulfill({
            status: 503,
            json: { message: "Private provider details" },
          });
        const messageId = `message-${state.messages.length + 1}`;
        state.messages.push({
          id: messageId,
          role: "user",
          text,
          createdAt: new Date().toISOString(),
        });
        state.runtime = {
          status: "running",
          compacting: false,
          sessionId: "private-session-id",
          runId: "private-run-id",
          error: null,
        };
        return route.fulfill({
          status: 202,
          json: { messageId, runId: "private-run-id" },
        });
      }
      if (state.failRead) return route.fulfill({ status: 503, json: {} });
      const url = new URL(request.url());
      const source = url.pathname.includes("/avery/") ? state.messages : [];
      const cursor = url.searchParams.get("before");
      const end = cursor
        ? source.findIndex((message) => message.id === cursor)
        : source.length;
      const start = Math.max(0, end - 100);
      const messages = source.slice(start, end);
      return route.fulfill({
        json: { messages, nextCursor: start > 0 ? messages[0]!.id : null },
      });
    },
  );
  return state;
}

test("one conversation opens from team cards, loads all history, replies, and survives navigation and reload", async ({
  page,
  context,
}, info) => {
  const state = await workspace(context);
  const errors: string[] = [];
  page.on("pageerror", (error) => errors.push(error.message));
  await page.goto("/team");
  await page
    .getByRole("link", { name: "Chat with Avery", exact: true })
    .click();
  await expect(page).toHaveURL(/\/team\/avery$/);
  await expect(page).toHaveTitle("Avery · Everything");
  await expect(page.locator(".chat-teammate")).toContainText("o3-mini · High");
  const log = page.getByRole("log", { name: "Conversation with Avery" });
  await expect(log.getByRole("article")).toHaveCount(100);
  await page
    .getByRole("button", { name: "Load earlier messages", exact: true })
    .click();
  await expect(log.getByRole("article")).toHaveCount(200);
  await page
    .getByRole("button", { name: "Load earlier messages", exact: true })
    .click();
  await expect(log.getByRole("article")).toHaveCount(205);
  await expect(
    page.getByRole("button", { name: "Load earlier messages" }),
  ).toHaveCount(0);
  await expect(log.getByRole("article").first()).toContainText(
    "Saved message 1",
  );
  const composer = page.getByRole("textbox", {
    name: "Message Avery",
    exact: true,
  });
  await composer.fill("Keep working on Kiwi");
  await composer.press("Shift+Enter");
  await composer.press("k");
  expect(state.sends).toEqual([]);
  await composer.press("Enter");
  await expect(composer).toHaveValue("");
  await expect(log.getByRole("article").last()).toContainText(
    "Keep working on Kiwi\nk",
  );
  await expect(
    page.getByRole("button", { name: "Stop reply", exact: true }),
  ).toBeVisible();
  state.runtime.compacting = true;
  await expect(
    page
      .getByRole("status")
      .filter({ hasText: "Summarizing earlier messages" }),
  ).toBeVisible({ timeout: 10000 });
  state.runtime.compacting = false;
  state.runtime.status = "idle";
  state.messages.push({
    id: "reply-kiwi",
    role: "assistant",
    text: "Kiwi is ready for the next step.",
    createdAt: new Date().toISOString(),
  });
  await expect(
    log.getByText("Kiwi is ready for the next step.", { exact: true }),
  ).toBeVisible({ timeout: 10000 });
  await expect(log.getByRole("article")).toHaveCount(207);
  await expect(page.getByText("private-session-id")).toHaveCount(0);
  await expect(page.getByRole("button", { name: /new chat/i })).toHaveCount(0);
  await expect(
    page.getByRole("textbox", { name: "Message Avery", exact: true }),
  ).toBeInViewport();
  await expect(
    page.getByRole("button", { name: "Send message", exact: true }),
  ).toBeInViewport();
  expect(
    await page.evaluate(
      () => document.documentElement.scrollWidth <= innerWidth,
    ),
  ).toBe(true);
  await page.screenshot({ path: info.outputPath("teammate-chat.png") });
  await page
    .getByRole("link", { name: "Back to your team", exact: true })
    .click();
  await page
    .getByRole("link", { name: "Chat with Blake", exact: true })
    .click();
  await expect(page.getByRole("log")).toBeEmpty();
  await page
    .getByRole("link", { name: "Back to your team", exact: true })
    .click();
  await page
    .getByRole("link", { name: "Chat with Avery", exact: true })
    .click();
  await expect(
    log.getByText("Kiwi is ready for the next step.", { exact: true }),
  ).toBeVisible();
  await page.reload();
  await expect(
    log.getByText("Kiwi is ready for the next step.", { exact: true }),
  ).toBeVisible();
  expect(state.sends).toEqual(["Keep working on Kiwi\nk"]);
  expect(errors).toEqual([]);
});

test("failed sends keep the draft, stop cancels work, and a dropped connection can reconnect", async ({
  page,
  context,
}) => {
  const state = await workspace(context);
  await page.goto("/team/avery");
  const composer = page.getByRole("textbox", {
    name: "Message Avery",
    exact: true,
  });
  await expect(composer).toBeEnabled();
  state.failSend = true;
  await composer.fill("Please keep this draft");
  await page.getByRole("button", { name: "Send message" }).click();
  await expect(page.getByRole("alert")).toContainText("Please try again");
  await expect(composer).toHaveValue("Please keep this draft");
  await expect(page.getByRole("alert")).not.toContainText("Private provider");
  state.failSend = false;
  await page.getByRole("button", { name: "Send message" }).click();
  await expect(
    page.getByRole("button", { name: "Stop reply", exact: true }),
  ).toBeVisible();
  await page.getByRole("button", { name: "Stop reply", exact: true }).click();
  await expect(
    page.getByRole("button", { name: "Stop reply", exact: true }),
  ).toHaveCount(0);
  expect(state.interruptions).toBe(1);
  expect(
    state.messages.filter(
      (message) => message.text === "Please keep this draft",
    ),
  ).toHaveLength(1);
  state.failRead = true;
  await expect(
    page.getByRole("button", { name: "Reconnect", exact: true }),
  ).toBeVisible({ timeout: 10000 });
  await expect(page.getByRole("log")).toContainText("Please keep this draft");
  state.failRead = false;
  await page.getByRole("button", { name: "Reconnect", exact: true }).click();
  await expect(page.getByRole("alert")).toHaveCount(0);
  await expect(composer).toBeEnabled();
});

test("a teammate without model settings keeps their history and explains how to enable sending", async ({
  page,
  context,
}) => {
  await workspace(context, false);
  await page.goto("/team/avery");
  await expect(page.getByRole("log")).toContainText("Saved message 205");
  await expect(
    page.getByRole("textbox", { name: "Message Avery", exact: true }),
  ).toBeDisabled();
  await page
    .getByRole("button", { name: "Choose a model", exact: true })
    .click();
  await expect(
    page.getByRole("dialog", { name: "Edit teammate", exact: true }),
  ).toBeVisible();
});
