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
      typing: false,
      backgroundCount: 0,
      sessionId: "private-session-id",
      runId: null as string | null,
      error: null as string | null,
    },
    failSend: false,
    failRead: false,
    sends: [] as string[],
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
        : {
            ...state.runtime,
            status: "idle",
            compacting: false,
            typing: false,
            backgroundCount: 0,
          },
    }),
  );
  await context.route("**/v1/agents/*/workspaces", (route) =>
    route.fulfill({
      json: { workspaces: [], observedAt: new Date().toISOString() },
    }),
  );
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
          typing: false,
          backgroundCount: 0,
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
  const teammate = page.getByRole("complementary", {
    name: "Avery teammate info",
  });
  await expect(teammate).toContainText("OpenAI-compatible API");
  await expect(teammate).toContainText("o3-mini");
  await expect(teammate).toContainText("High");
  const background = teammate.getByRole("status", {
    name: "Active background teammates",
  });
  await expect(background).toHaveCount(0);
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
  // Background work updates the card; only writing a message shows typing bubbles.
  const typing = page.getByText("Avery is typing", { exact: true });
  state.runtime.compacting = true;
  state.runtime.backgroundCount = 2;
  await expect(background).toHaveText("2 background");
  await page.waitForTimeout(1500);
  await page.screenshot({ path: info.outputPath("background-working.png") });
  await expect(typing).toHaveCount(0);
  await expect(page.getByText(/replying|Summarizing/)).toHaveCount(0);
  await expect(page.getByRole("button", { name: "Stop reply" })).toHaveCount(0);
  state.runtime.compacting = false;
  state.runtime.typing = true;
  state.runtime.backgroundCount = 1;
  await expect(background).toHaveText("1 background");
  await expect(typing).toBeAttached({ timeout: 5000 });
  await expect(page.locator(".chat-typing-bubble")).toBeVisible();
  state.runtime.typing = false;
  state.runtime.status = "idle";
  await expect(typing).toHaveCount(0);
  await expect(background).toHaveText("1 background");
  state.runtime.backgroundCount = 0;
  await expect(background).toHaveCount(0, { timeout: 3000 });
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
  await expect(typing).toHaveCount(0);
  await expect(background).toHaveCount(0);
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

test("failed sends keep the draft, work shows no controls, and a dropped connection can reconnect", async ({
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
  await expect(composer).toHaveValue("");
  await expect(page.getByRole("button", { name: "Stop reply" })).toHaveCount(0);
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

test("Markdown messages render formatting, contain wide content, and retain their original source", async ({
  page,
  context,
}, info) => {
  const state = await workspace(context);
  const code = `const greeting = "${"hello ".repeat(60)}";\nconsole.log(greeting);`;
  const markdown = [
    "## A useful plan",
    "",
    "**Start small**, *keep learning*, and ~~skip the checks~~ verify each step.",
    "First line\nSecond line",
    "",
    "- Read the brief",
    "  - Ask a question",
    "- Use `pnpm build`",
    "",
    "1. Make the change",
    "2. Review the result",
    "",
    "> Keep the next step clear.",
    "",
    "- [x] Plan ready",
    "- [ ] Review pending",
    "",
    "[Read the guide](https://example.com/guide)",
    "",
    "```ts",
    code,
    "```",
    "",
    "| Task | Owner | Status | Priority | Notes |",
    "| --- | --- | --- | --- | --- |",
    "| Planning | Avery | Ready | High | Review together |",
    "",
    "A source[^1].",
    "",
    "[^1]: First reference.",
  ].join("\n");
  state.messages = [
    {
      id: "formatted-reply",
      role: "assistant",
      text: markdown,
      createdAt: "2026-10-12T10:00:00Z",
    },
    {
      id: "formatted-user",
      role: "user",
      text: "**My notes**\nKeep this line break.\n\nAnother source[^1].\n\n[^1]: Second reference.",
      createdAt: "2026-10-12T10:01:00Z",
    },
  ];
  await page.goto("/team/avery");
  const log = page.getByRole("log");
  const reply = log.getByRole("article").first();
  await expect(
    reply.getByRole("heading", { name: "A useful plan" }),
  ).toBeVisible();
  await expect(reply.locator(".chat-markdown strong")).toHaveText(
    "Start small",
  );
  await expect(reply.locator("em")).toHaveText("keep learning");
  await expect(reply.locator("del")).toHaveText("skip the checks");
  await expect(reply.locator("blockquote")).toContainText(
    "Keep the next step clear.",
  );
  await expect(reply.locator("ul ul li")).toHaveText("Ask a question");
  await expect(reply.locator("input[type=checkbox]").first()).toBeChecked();
  await expect(reply.locator("input[type=checkbox]").last()).toBeDisabled();
  await expect(reply.locator("br")).toHaveCount(2);
  await expect(reply.locator("pre code")).toHaveText(`${code}\n`);
  await expect(reply.getByRole("table")).toContainText("Planning");
  const guide = reply.getByRole("link", { name: "Read the guide" });
  await expect(guide).toHaveAttribute("href", "https://example.com/guide");
  await expect(guide).toHaveAttribute("target", "_blank");
  await expect(guide).toHaveAttribute("rel", "noopener noreferrer");
  await expect(
    log.getByRole("article").last().locator(".chat-markdown strong"),
  ).toHaveText("My notes");
  const footnotes = await log
    .locator("a[data-footnote-ref]")
    .evaluateAll((links) =>
      links.map((link) => ({
        href: link.getAttribute("href"),
        local: link
          .closest("article")
          ?.contains(
            document.getElementById(link.getAttribute("href")!.slice(1)),
          ),
        label: link
          .closest("article")
          ?.contains(
            document.getElementById(link.getAttribute("aria-describedby")!),
          ),
        target: link.getAttribute("target"),
      })),
    );
  expect(footnotes).toHaveLength(2);
  expect(new Set(footnotes.map((note) => note.href)).size).toBe(2);
  expect(
    footnotes.every((note) => note.local && note.label && note.target === null),
  ).toBe(true);
  expect(
    await reply
      .locator("pre")
      .evaluate((element) => element.scrollWidth > element.clientWidth),
  ).toBe(true);
  expect(
    await page.evaluate(
      () => document.documentElement.scrollWidth <= innerWidth,
    ),
  ).toBe(true);
  await reply.getByRole("heading").first().scrollIntoViewIfNeeded();
  await page.screenshot({ path: info.outputPath("markdown-chat.png") });

  const draft = "### My update\n\n- **Done**\n- Ready to review";
  await page
    .getByRole("textbox", { name: "Message Avery", exact: true })
    .fill(draft);
  await page.getByRole("button", { name: "Send message", exact: true }).click();
  await expect(
    log.getByRole("article").last().getByRole("heading", { name: "My update" }),
  ).toBeVisible();
  expect(state.sends).toEqual([draft]);
  await page.reload();
  await expect(
    log.getByRole("article").last().getByRole("heading", { name: "My update" }),
  ).toBeVisible();
  expect(state.messages[0]!.text).toBe(markdown);
});

test("Markdown keeps raw HTML inert and removes unsafe link and image destinations", async ({
  page,
  context,
}) => {
  const state = await workspace(context);
  const html =
    '<img src="/markdown-probe" onerror="document.body.dataset.markdownExecuted = true">';
  state.messages = [
    {
      id: "untrusted-markdown",
      role: "assistant",
      text: [
        html,
        "",
        "[unsafe link](javascript:alert(1))",
        "",
        "![unsafe image](javascript:alert(1))",
        "",
        "```html",
        html,
        "```",
      ].join("\n"),
      createdAt: "2026-10-12T10:00:00Z",
    },
  ];
  let probeRequested = false;
  await context.route("**/markdown-probe", (route) => {
    probeRequested = true;
    return route.fulfill({ status: 404, body: "" });
  });
  await page.goto("/team/avery");
  const message = page.getByRole("log").getByRole("article");
  await expect(message).toContainText(html);
  await expect(message).toContainText("unsafe link");
  await expect(message).toContainText("unsafe image");
  await expect(message.locator("a, img, script, iframe")).toHaveCount(0);
  await expect(message.locator("pre code")).toHaveText(`${html}\n`);
  expect(
    await page.locator("body").getAttribute("data-markdown-executed"),
  ).toBeNull();
  expect(probeRequested).toBe(false);
});
