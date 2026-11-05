import { expect, test, type BrowserContext, type Page } from "@playwright/test";
import { mkdir, readFile, writeFile } from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";

/** The teammate the jobs gateway serves. */
const agentId = "5d0c6a52-8b8e-4c55-9c1a-3f1d2e7b9a10";

/** The gateway's test-only controls and the folder where it records what the mocked model received. */
const gateway = `http://127.0.0.1:${process.env.JOBS_E2E_GATEWAY_PORT}`;
const root = process.env.JOBS_E2E_ROOT!;

/** Screenshots and the run record kept as evidence, outside Playwright's cleared output folder. */
const evidence = fileURLToPath(
  new URL(
    "../../../../../.local/ui-test-results/jobs-e2e-evidence/",
    import.meta.url,
  ),
);

/**
 * Sign in with the gateway's test session and mock the chat page's unrelated routes. Session,
 * runtime status, messages, and jobs reach the real gateway.
 */
async function workspace(context: BrowserContext, baseURL: string) {
  await context.addCookies([
    { name: "everything-session", value: "jobs-e2e-session", url: baseURL },
  ]);
  await context.route("**/v1/**", (route) =>
    route.fulfill({
      status: 404,
      json: { code: "NOT_FOUND", message: "Not found" },
    }),
  );
  const json = (pattern: string | RegExp, body: unknown) =>
    context.route(pattern, (route) => route.fulfill({ json: body }));
  const teammate = {
    id: agentId,
    name: "Avery",
    avatarId: "avatar-03",
    systemPrompt: "Keep an eye on the project.",
    createdAt: "2026-10-30T09:00:00.000Z",
    inference: { provider: "anthropic", model: "mocked-model", effort: "high" },
  };
  await json("**/v1/providers", { providers: [] });
  await json("**/v1/agents", { agents: [teammate] });
  await json("**/v1/agents/recent", { agents: [teammate] });
  await json("**/v1/settings/teammate-order", { teammateIds: [] });
  await json("**/v1/updates**", {
    updates: [],
    nextCursor: null,
    unread: 0,
    byAgent: {},
  });
  await json("**/v1/voice/capabilities", {
    available: false,
    maxDurationMs: 60_000,
    maxBytes: 8 * 1024 * 1024,
    mediaTypes: ["audio/webm", "audio/ogg", "audio/mp4"],
    responseTimeoutMs: 195_000,
  });
  await context.route("**/v1/agents/*/workspaces", (route) =>
    route.fulfill({
      json: { workspaces: [], observedAt: new Date().toISOString() },
    }),
  );
  await json(/\/v1\/agents\/[^/]+\/attachments(?:\?.*)?$/, { attachments: [] });
  await context.route("**/v1/agents/*/messages/read", (route) =>
    route.fulfill({ status: 204 }),
  );
  const real = (route: Parameters<Parameters<typeof context.route>[1]>[0]) =>
    route.continue();
  await context.route("**/v1/session", real);
  await context.route("**/v1/agents/*/runtime", real);
  await context.route(/\/v1\/agents\/[^/]+\/messages(?:\?.*)?$/, real);
  await context.route(/\/v1\/agents\/[^/]+\/jobs(?:[/?].*)?$/, real);
}

/** The Jobs card beside the chat. */
function jobsCard(page: Page) {
  return page.getByRole("complementary", { name: "Jobs" });
}

/** Choose an option from one of the shared themed dropdowns. */
async function choose(
  page: Page,
  scope: ReturnType<Page["getByRole"]>,
  label: string,
  option: string,
) {
  await scope.getByRole("combobox", { name: label }).click();
  await page.getByRole("option", { name: option, exact: true }).click();
}

/** Whether anything is wider than the viewport. */
async function overflows(page: Page): Promise<boolean> {
  return page.evaluate(
    () => document.documentElement.scrollWidth > window.innerWidth,
  );
}

test("@desktop a job is created with a previewed schedule, runs through the teammate on time, and is controlled from its history", async ({
  page,
  context,
  baseURL,
  request,
}) => {
  await mkdir(evidence, { recursive: true });
  await workspace(context, baseURL!);
  await page.goto(`/team/${agentId}`);
  const card = jobsCard(page);
  await expect(
    card.getByRole("button", { name: /Weekday PR check/ }),
  ).toContainText("Cron 0 9 * * 1-5 (Europe/Paris)");
  await expect(
    card.getByRole("button", { name: /Nightly backup check/ }),
  ).toContainText("Last run failed");
  await page.screenshot({ path: `${evidence}desktop-1-jobs.png` });

  // A cron schedule previews three times in the browser's timezone before saving.
  await card.getByRole("button", { name: "New job" }).click();
  const editor = page.getByRole("dialog", { name: "New job" });
  await editor.getByLabel("Name", { exact: true }).fill("Release watch");
  const instructions =
    "Check the releases page and tell me only when there is a new release.";
  await editor.getByLabel("Instructions", { exact: true }).fill(instructions);
  // Help text describes each field without becoming part of its name.
  await expect(
    editor.getByLabel("Instructions", { exact: true }),
  ).toHaveAccessibleDescription(
    "Each run starts fresh. Ask Avery to keep notes in its workspace if a later run needs them.",
  );
  await choose(page, editor, "Schedule", "Cron schedule");
  await expect(
    editor.getByLabel("Cron expression", { exact: true }),
  ).toHaveValue("0 9 * * 1-5");
  await expect(
    editor.getByLabel("Cron expression", { exact: true }),
  ).toHaveAccessibleDescription(
    "Five numbers or ranges: minute, hour, day of month, month, and day of week. 0 9 * * 1-5 runs at 9:00 on weekdays.",
  );
  await expect(
    editor.getByRole("combobox", { name: "Timezone" }),
  ).toContainText("Europe/Paris");
  // The preview shows this schedule's own times, never an earlier schedule's while it updates.
  await expect(editor.locator(".job-preview li")).toHaveCount(3);
  await expect(editor.locator(".job-preview li")).toHaveText([
    /, 9:00\sAM$/,
    /, 9:00\sAM$/,
    /, 9:00\sAM$/,
  ]);
  await editor.locator(".job-preview").scrollIntoViewIfNeeded();
  await page.screenshot({ path: `${evidence}desktop-2-new-job.png` });
  // The server refuses matches closer than five minutes, and the form can't be saved.
  await editor
    .getByLabel("Cron expression", { exact: true })
    .fill("*/2 * * * *");
  await expect(
    editor.getByText(/keep runs at least five minutes apart/),
  ).toBeVisible();
  await expect(
    editor.getByRole("button", { name: "Create job" }),
  ).toBeDisabled();

  await choose(page, editor, "Schedule", "Once");
  await expect(
    editor.getByLabel("Date and time", { exact: true }),
  ).toHaveAccessibleDescription("In your timezone, Europe/Paris.");
  await choose(page, editor, "Schedule", "Repeat every…");
  await editor.getByLabel("Every", { exact: true }).fill("15");
  await expect(
    editor.getByLabel("Every", { exact: true }),
  ).toHaveAccessibleDescription(
    "The first run is one interval after you save. At least five minutes.",
  );
  await choose(page, editor, "Interval unit", "minutes");
  await expect(editor.locator(".job-preview li")).toHaveCount(3);
  await expect
    .poll(async () => {
      const times = await editor
        .locator(".job-preview time")
        .evaluateAll((items) =>
          items.map((item) => Date.parse(item.getAttribute("datetime")!)),
        );
      return times.slice(1).map((time, index) => time - times[index]!);
    })
    .toEqual([15 * 60_000, 15 * 60_000]);
  const saving = page.waitForResponse(
    (response) =>
      response.url().endsWith(`/v1/agents/${agentId}/jobs`) &&
      response.request().method() === "POST",
  );
  await editor.getByRole("button", { name: "Create job" }).click();
  const saved = await saving;
  expect(saved.status()).toBe(201);
  expect(saved.request().postDataJSON()).toEqual({
    name: "Release watch",
    instructions,
    schedule: { type: "interval", seconds: 900 },
  });
  const row = card.getByRole("button", { name: /Release watch/ });
  await expect(row).toContainText("Every 15 minutes");
  await expect(row).toContainText("Next");

  // Skip ahead fifteen minutes: the real scheduler claims the occurrence and wakes the teammate.
  const advanced = await request.post(
    `${gateway}/e2e/advance?ms=${15 * 60_000 + 500}`,
  );
  expect(advanced.ok()).toBe(true);
  await row.click();
  const details = page.getByRole("dialog", { name: "Release watch" });
  const latest = details.locator(".job-run").first();
  await expect(latest).toContainText("Running");
  await page.screenshot({ path: `${evidence}desktop-3-running.png` });
  await expect(latest).toContainText("Completed", { timeout: 20_000 });

  // The background reply woke main, which messaged the user in the chat.
  await details.getByRole("button", { name: "Close", exact: true }).click();
  await expect(
    page.getByText("(Mocked model reply.) Release watch ran in the background"),
  ).toBeVisible({ timeout: 20_000 });
  await page.screenshot({ path: `${evidence}desktop-4-reply.png` });

  // Run now, then stop it: only that run is cancelled, and the job stays on its schedule.
  await row.click();
  await details.getByRole("button", { name: "Run now" }).click();
  await details.getByRole("button", { name: "Stop run" }).click();
  await expect(latest).toContainText("Cancelled", { timeout: 15_000 });
  await expect(latest).toContainText(
    "Stopped from the job before it finished.",
  );
  await details.getByRole("button", { name: "Pause" }).click();
  await expect(details.locator(".job-facts")).toContainText("Paused");
  await details.getByRole("button", { name: "Resume" }).click();
  await expect(details.locator(".job-facts")).toContainText("Next");
  await expect(details.locator(".job-run")).toHaveCount(2);
  await page.screenshot({ path: `${evidence}desktop-5-history.png` });

  // What the mocked model received: the job's task in a background session, then main's wakeup.
  const state = await (await request.get(`${gateway}/e2e/state`)).json();
  const backgroundTask = await readFile(
    path.join(root, "evidence", "background-task-1.txt"),
    "utf8",
  );
  const mainInput = await readFile(
    path.join(root, "evidence", "main-input-1.txt"),
    "utf8",
  );
  expect(backgroundTask).toMatch(
    /^Background task from scheduled job:\nScheduled job "Release watch", which runs every 15 minutes\.\nThis run was due at /,
  );
  expect(backgroundTask).toContain(instructions);
  expect(mainInput).toMatch(
    /^Fork [0-9a-f-]+ finished:\n\(Mocked background reply\.\)/,
  );
  expect(state.failures).toEqual([]);
  const job = state.jobs.find(
    (item: { name: string }) => item.name === "Release watch",
  );
  await writeFile(
    `${evidence}jobs-evidence.json`,
    `${JSON.stringify(
      {
        job,
        runs: state.runs.filter(
          (run: { jobId: string }) => run.jobId === job.id,
        ),
        backgroundTask,
        mainInput,
        dispatcherFailures: state.failures,
      },
      null,
      2,
    )}\n`,
  );

  // Deleting asks first, then removes the job and its history.
  await details.getByRole("button", { name: "Delete", exact: true }).click();
  await details.getByRole("button", { name: "Delete job" }).click();
  await expect(details).toBeHidden();
  await expect(row).toHaveCount(0);
});

test("@phone jobs fit a phone: the card behind Details, a job's history, and the editor", async ({
  page,
  context,
  baseURL,
}) => {
  await mkdir(evidence, { recursive: true });
  await workspace(context, baseURL!);
  await page.goto(`/team/${agentId}`);
  await page.getByRole("button", { name: "Details" }).click();
  const card = jobsCard(page);
  const nightly = card.getByRole("button", { name: /Nightly backup check/ });
  await nightly.scrollIntoViewIfNeeded();
  await expect(nightly).toBeVisible();
  expect(await overflows(page)).toBe(false);
  await page.screenshot({ path: `${evidence}phone-1-jobs.png` });

  await nightly.click();
  const details = page.getByRole("dialog", { name: "Nightly backup check" });
  await expect(details.locator(".job-run")).toHaveCount(2);
  await expect(details.locator(".job-run").first()).toContainText(
    "model provider isn't connected",
  );
  expect(await overflows(page)).toBe(false);
  await details.locator(".job-run").last().scrollIntoViewIfNeeded();
  await page.screenshot({ path: `${evidence}phone-2-history.png` });
  await details.getByRole("button", { name: "Close", exact: true }).click();

  await card.getByRole("button", { name: "New job" }).click();
  const editor = page.getByRole("dialog", { name: "New job" });
  await editor.getByLabel("Name", { exact: true }).fill("Weekly open loops");
  await editor
    .getByLabel("Instructions", { exact: true })
    .fill("Every Friday, list anything I promised and haven't finished.");
  await expect(
    editor.getByLabel("Instructions", { exact: true }),
  ).toHaveAccessibleDescription(
    "Each run starts fresh. Ask Avery to keep notes in its workspace if a later run needs them.",
  );
  await choose(page, editor, "Schedule", "Cron schedule");
  await editor
    .getByLabel("Cron expression", { exact: true })
    .fill("0 16 * * 5");
  await expect(editor.locator(".job-preview li")).toHaveCount(3);
  await expect(editor.locator(".job-preview li")).toHaveText([
    /, 4:00\sPM$/,
    /, 4:00\sPM$/,
    /, 4:00\sPM$/,
  ]);
  expect(await overflows(page)).toBe(false);
  await editor.locator(".job-preview").scrollIntoViewIfNeeded();
  await page.screenshot({ path: `${evidence}phone-3-editor.png` });
  await editor.getByRole("button", { name: "Cancel" }).click();
  await expect(editor).toBeHidden();
});
