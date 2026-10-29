import { randomUUID } from "node:crypto";
import {
  expect,
  test,
  type BrowserContext,
  type Page,
  type Route,
} from "@playwright/test";

// Routed fixtures only: these checks need the UI, not a running API, so they also work against a
// locally served UI build (UI_TEST_ORIGIN).

const credentialId = "11111111-1111-4111-8111-111111111111";
const appId = "00000000-0000-4000-8000-000000000001";
const credentialName = "slack-bot-token";

/** One scripted answer, optionally held until a promise settles. */
interface Answer {
  readonly status: number;
  readonly json: unknown;
  readonly after?: Promise<unknown>;
}

/** Answers given in order; the last one repeats. */
class Script {
  private readonly answers: Answer[];
  calls = 0;

  constructor(...answers: Answer[]) {
    this.answers = answers;
  }

  /** Fulfill a request with the next answer. */
  async answer(route: Route): Promise<void> {
    const answer = this.answers[Math.min(this.calls, this.answers.length - 1)]!;
    this.calls++;
    await answer.after;
    await route.fulfill({ status: answer.status, json: answer.json });
  }

  /** Replace the remaining answers. */
  then(...answers: Answer[]): void {
    this.answers.splice(this.calls, this.answers.length, ...answers);
  }
}

/** A failure the API returns while apps can't be reached. */
const unavailable: Answer = {
  status: 503,
  json: { code: "ARTIFACTS_UNAVAILABLE", message: "Server text never shown" },
};

/** The credential's usage with one app in the given status, or none. */
function usage(status?: string): Answer {
  return {
    status: 200,
    json: {
      apps: status
        ? [
            {
              appId,
              slug: "slack-bot",
              title: "Slack bot",
              env: "SLACK_BOT_TOKEN",
              status,
            },
          ]
        : [],
      otherApps: 0,
    },
  };
}

/** The app's summary with its credentials in the given status, or none. */
function app(status?: string) {
  return {
    id: appId,
    slug: "slack-bot",
    title: "Slack bot",
    status: "running",
    kind: "dynamic",
    description: "Shared app",
    database: false,
    capabilities: [],
    credentials: status
      ? [
          {
            credentialId,
            name: credentialName,
            env: "SLACK_BOT_TOKEN",
            version: 2,
            status,
          },
        ]
      : [],
    url: "http://localhost:8081/slack-bot/",
    publicUrl: "http://public.apps.test/slack-bot/",
    visibility: "private",
    release: 1,
    createdAt: new Date(Date.now() - 86_400_000).toISOString(),
    updatedAt: new Date().toISOString(),
    createdBy: { id: "ada", name: "Ada" },
    updatedBy: { id: "ada", name: "Ada" },
  };
}

/** Route the endpoints the Keys and Apps pages use, with scripted credential answers. */
async function prepare(context: BrowserContext) {
  const state = {
    usage: new Script(usage("applied")),
    replace: new Script(unavailable),
    create: new Script(unavailable),
    detach: new Script(unavailable),
    apps: new Script({ status: 200, json: { artifacts: [app("applied")] } }),
    /** Runs when a removal reaches the API, before it is answered. */
    onDetach: undefined as (() => void) | undefined,
  };
  await context.route("**/v1/session", (route) =>
    route.fulfill({
      json: { profile: { subject: "keys-fixture", displayName: "Keys check" } },
    }),
  );
  await context.route("**/v1/settings/teammate-order", (route) =>
    route.fulfill({ json: { teammateIds: [] } }),
  );
  for (const path of ["agents", "providers"])
    await context.route(`**/v1/${path}`, (route) =>
      route.fulfill({ json: { [path]: [] } }),
    );
  await context.route("**/v1/keys", (route) =>
    route.request().method() === "POST"
      ? state.create.answer(route)
      : route.fulfill({
          json: {
            keys: [
              {
                id: credentialId,
                name: credentialName,
                type: "generic",
                description: "",
                createdAt: "2026-10-20T00:00:00.000Z",
                updatedAt: "2026-10-21T00:00:00.000Z",
                owned: true,
              },
            ],
          },
        }),
  );
  await context.route(`**/v1/keys/${credentialId}/apps`, (route) =>
    state.usage.answer(route),
  );
  await context.route(`**/v1/keys/${credentialId}/value`, (route) =>
    state.replace.answer(route),
  );
  await context.route("**/v1/artifacts", (route) => state.apps.answer(route));
  await context.route(`**/v1/artifacts/${appId}/credentials/*`, (route) => {
    state.onDetach?.();
    return state.detach.answer(route);
  });
  return state;
}

/** Whether the page's JavaScript heap, after garbage collection, still holds the string. */
async function heapHolds(page: Page, needle: string): Promise<boolean> {
  const cdp = await page.context().newCDPSession(page);
  const chunks: string[] = [];
  cdp.on("HeapProfiler.addHeapSnapshotChunk", ({ chunk }) =>
    chunks.push(chunk),
  );
  await cdp.send("HeapProfiler.enable");
  await cdp.send("HeapProfiler.collectGarbage");
  await cdp.send("HeapProfiler.collectGarbage");
  await cdp.send("HeapProfiler.takeHeapSnapshot", { reportProgress: false });
  await cdp.detach();
  return chunks.join("").includes(needle);
}

/** A fake value made in the test runner, so the page only ever receives it by typing. */
function sentinel(): string {
  return `heap-sentinel-${randomUUID()}`;
}

test("a value that failed to save, or saved, isn't kept in the page's memory once the dialog closes", async ({
  page,
  context,
}) => {
  const state = await prepare(context);
  await page.goto("/keys");

  // Replacing: two failed attempts, then Cancel.
  const failed = sentinel();
  await page
    .getByRole("button", { name: `Replace value of ${credentialName}` })
    .click();
  const replace = page.getByRole("dialog", { name: "Replace value" });
  await replace.getByRole("textbox", { name: "Value" }).fill(failed);
  for (const attempt of [1, 2]) {
    await replace.getByRole("button", { name: "Replace value" }).click();
    await expect(replace.getByRole("alert")).toContainText("unavailable");
    expect(state.replace.calls).toBe(attempt);
  }
  await replace.getByRole("button", { name: "Cancel" }).click();
  await expect(replace).toHaveCount(0);
  expect(await heapHolds(page, failed)).toBe(false);

  // Adding: two failed attempts, then Cancel.
  const unsaved = sentinel();
  await page.getByRole("button", { name: "Add key", exact: true }).click();
  const add = page.getByRole("dialog", { name: "Add key", exact: true });
  await add.getByRole("textbox", { name: "Key name" }).fill("another-token");
  await add.getByRole("combobox", { name: "Key type", exact: true }).click();
  await page
    .getByRole("option", { name: "Generic credential", exact: true })
    .click();
  await add.getByRole("textbox", { name: "Value" }).fill(unsaved);
  for (const attempt of [1, 2]) {
    await add.getByRole("button", { name: "Add key", exact: true }).click();
    await expect(add.getByRole("alert")).toBeVisible();
    expect(state.create.calls).toBe(attempt);
  }
  await add.getByRole("button", { name: "Cancel" }).click();
  await expect(add).toHaveCount(0);
  expect(await heapHolds(page, unsaved)).toBe(false);

  // Replacing successfully: the result stays open while apps restart.
  const saved = sentinel();
  state.replace.then({
    status: 200,
    json: {
      key: {
        id: credentialId,
        name: credentialName,
        type: "generic",
        description: "",
        createdAt: "2026-10-20T00:00:00.000Z",
        updatedAt: new Date().toISOString(),
        owned: true,
      },
      rollout: { complete: true, usage: usage("applied").json },
    },
  });
  await page
    .getByRole("button", { name: `Replace value of ${credentialName}` })
    .click();
  await page
    .getByRole("dialog", { name: "Replace value" })
    .getByRole("textbox", { name: "Value" })
    .fill(saved);
  await page
    .getByRole("dialog", { name: "Replace value" })
    .getByRole("button", { name: "Replace value" })
    .click();
  const result = page.getByRole("dialog", { name: "Value replaced" });
  await expect(result).toBeVisible();
  expect(await heapHolds(page, saved)).toBe(false);
  await result.getByRole("button", { name: "Done" }).click();
  await expect(result).toHaveCount(0);

  // Adding successfully: the dialog closes once the key is saved.
  const created = sentinel();
  state.create.then({
    status: 201,
    json: {
      id: "22222222-2222-4222-8222-222222222222",
      name: "added-token",
      type: "generic",
      description: "",
      createdAt: new Date().toISOString(),
      updatedAt: new Date().toISOString(),
      owned: true,
    },
  });
  await page.getByRole("button", { name: "Add key", exact: true }).click();
  await add.getByRole("textbox", { name: "Key name" }).fill("added-token");
  await add.getByRole("combobox", { name: "Key type", exact: true }).click();
  await page
    .getByRole("option", { name: "Generic credential", exact: true })
    .click();
  await add.getByRole("textbox", { name: "Value" }).fill(created);
  await add.getByRole("button", { name: "Add key", exact: true }).click();
  await expect(add).toHaveCount(0);
  expect(state.create.calls).toBe(3);
  expect(await heapHolds(page, created)).toBe(false);
});

test("usage read before a replacement was saved never shows the new value as in use", async ({
  page,
  context,
}) => {
  const state = await prepare(context);
  let answerRead = () => {};
  let answerSave = () => {};
  // The form's usage read describes the old value but is answered only after the save started;
  // every read after the save fails until apps can be reached again.
  state.usage = new Script(
    {
      ...usage("applied"),
      after: new Promise<void>((resolve) => (answerRead = resolve)),
    },
    unavailable,
  );
  state.replace = new Script({
    status: 200,
    json: {
      key: {
        id: credentialId,
        name: credentialName,
        type: "generic",
        description: "",
        createdAt: "2026-10-20T00:00:00.000Z",
        updatedAt: new Date().toISOString(),
        owned: true,
      },
      rollout: { complete: false, usage: null },
    },
    after: new Promise<void>((resolve) => (answerSave = resolve)),
  });
  await page.goto("/keys");
  await page
    .getByRole("button", { name: `Replace value of ${credentialName}` })
    .click();
  const replace = page.getByRole("dialog", { name: "Replace value" });
  await expect(replace).toContainText("Checking which apps use it");
  await replace.getByRole("textbox", { name: "Value" }).fill(sentinel());
  await replace.getByRole("button", { name: "Replace value" }).click();
  await expect(replace.getByRole("button", { name: "Saving…" })).toBeVisible();
  // The old read arrives while the save is still on its way.
  answerRead();
  await expect(
    replace.getByRole("list", { name: "Apps that use it" }),
  ).toContainText("In use");
  answerSave();
  const result = page.getByRole("dialog", { name: "Value replaced" });
  await expect(result).toBeVisible();
  // The save's own answer couldn't reach apps, and no read after it has succeeded.
  await expect.poll(() => state.usage.calls).toBeGreaterThanOrEqual(2);
  await expect(result).toContainText("couldn’t be checked");
  await expect(result).toContainText(
    "Saved. Everything couldn’t reach your apps yet and keeps trying.",
  );
  await expect(result).not.toContainText("In use");
  await expect(result).not.toContainText("All apps use the new value");

  // Once apps can be reached, reads after the save show them catching up.
  state.usage.then(usage("pending"), usage("applied"));
  await expect(
    result.getByRole("list", { name: "Apps that use it" }),
  ).toContainText("Restarting", { timeout: 15_000 });
  await expect(result).toContainText("Saved. All apps use the new value.", {
    timeout: 15_000,
  });
});

test("usage that couldn't be read recovers while the dialog stays open, and can be retried", async ({
  page,
  context,
}) => {
  const state = await prepare(context);
  state.usage = new Script(unavailable, unavailable, usage("removing"));
  await page.goto("/keys");
  await page
    .getByRole("button", { name: `Apps using ${credentialName}` })
    .click();
  const dialog = page.getByRole("dialog", {
    name: `Apps using ${credentialName}`,
  });
  await expect(dialog).toContainText("couldn’t be checked");
  await expect(dialog.getByRole("button", { name: "Try again" })).toBeVisible();
  // No click, focus change, or reopen: the followed usage is retried by itself, with a growing
  // delay. The status is read from the list, since the dialog's own text mentions removing.
  await expect(
    dialog.getByRole("list", { name: "Apps that use it" }),
  ).toContainText("Removing", { timeout: 15_000 });
  await expect(dialog).not.toContainText("couldn’t be checked");

  // While statuses change they are read again; a failure there is shown and can be retried.
  state.usage.then(unavailable);
  await expect(dialog).toContainText("couldn’t be checked", {
    timeout: 10_000,
  });
  state.usage.then(usage("applied"));
  await dialog.getByRole("button", { name: "Try again" }).click();
  await expect(dialog).toContainText("In use", { timeout: 10_000 });
});

test("a replacement saved while apps were unreachable shows them catching up", async ({
  page,
  context,
}) => {
  const state = await prepare(context);
  state.replace = new Script({
    status: 200,
    json: {
      key: {
        id: credentialId,
        name: credentialName,
        type: "generic",
        description: "",
        createdAt: "2026-10-20T00:00:00.000Z",
        updatedAt: new Date().toISOString(),
        owned: true,
      },
      rollout: { complete: false, usage: null },
    },
  });
  await page.goto("/keys");
  await page
    .getByRole("button", { name: `Replace value of ${credentialName}` })
    .click();
  const replace = page.getByRole("dialog", { name: "Replace value" });
  await expect(replace).toContainText("Slack bot");
  state.usage.then(
    unavailable,
    usage("updating"),
    usage("pending"),
    usage("applied"),
  );
  await replace.getByRole("textbox", { name: "Value" }).fill("new-value-1234");
  await replace.getByRole("button", { name: "Replace value" }).click();
  const result = page.getByRole("dialog", { name: "Value replaced" });
  await expect(result).toContainText("couldn’t reach your apps yet");
  await expect(result).toContainText("restarting", { timeout: 15_000 });
  await expect(result).toContainText("Updating");
  await expect(result).toContainText("All apps use the new value", {
    timeout: 15_000,
  });
  await expect(result).toContainText("In use");
  await expect(result).not.toContainText("couldn’t reach");
});

for (const failure of ["unavailable", "saved"] as const)
  test(`removing a credential from an app shows it as removing until it's gone (${failure} answer)`, async ({
    page,
    context,
  }) => {
    const state = await prepare(context);
    state.detach =
      failure === "unavailable"
        ? new Script(unavailable)
        : new Script({
            status: 200,
            json: {
              credentials: app("removing").credentials,
            },
          });
    await page.goto("/apps");
    const card = page.getByRole("article", { name: "Slack bot", exact: true });
    await card
      .getByRole("button", { name: "Credentials for Slack bot", exact: true })
      .click();
    const dialog = page.getByRole("dialog", {
      name: "Credentials for Slack bot",
    });
    await expect(dialog).toContainText("In use");
    state.onDetach = () =>
      state.apps.then(
        { status: 200, json: { artifacts: [app("removing")] } },
        { status: 200, json: { artifacts: [app("removing")] } },
        { status: 200, json: { artifacts: [app()] } },
      );
    await dialog
      .getByRole("button", { name: "Remove SLACK_BOT_TOKEN", exact: true })
      .click();
    await page
      .getByRole("alertdialog", { name: "Remove credential?" })
      .getByRole("button", { name: "Remove credential" })
      .click();
    await expect(
      page.getByRole("alertdialog", { name: "Remove credential?" }),
    ).toHaveCount(0);
    if (failure === "unavailable")
      await expect(dialog.getByRole("alert")).toContainText(
        "may already be saved",
      );
    // Read the status from the list: the failure message also mentions removing.
    await expect(
      dialog.getByRole("list", { name: "Attached credentials" }),
    ).toContainText("Removing");
    await expect(
      dialog.getByRole("button", { name: "Remove SLACK_BOT_TOKEN" }),
    ).toHaveCount(0);
    await expect(dialog).not.toContainText("SLACK_BOT_TOKEN", {
      timeout: 20_000,
    });
    expect(state.detach.calls).toBe(1);
  });

test("removing from the Keys page after a failed answer shows the refreshed statuses", async ({
  page,
  context,
}) => {
  const state = await prepare(context);
  await page.goto("/keys");
  await page
    .getByRole("button", { name: `Apps using ${credentialName}` })
    .click();
  const dialog = page.getByRole("dialog", {
    name: `Apps using ${credentialName}`,
  });
  await expect(dialog).toContainText("In use");
  state.onDetach = () =>
    state.usage.then(usage("removing"), usage("removing"), usage());
  await dialog.getByRole("button", { name: "Remove from Slack bot" }).click();
  await page
    .getByRole("alertdialog", { name: "Remove from app?" })
    .getByRole("button", { name: "Remove credential" })
    .click();
  await expect(dialog.getByRole("alert")).toContainText("may already be saved");
  await expect(
    dialog.getByRole("list", { name: "Apps that use it" }),
  ).toContainText("Removing");
  await expect(dialog).toContainText("No app uses this credential", {
    timeout: 15_000,
  });
});
