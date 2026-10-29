import { expect, test, type BrowserContext } from "@playwright/test";

const slackId = "11111111-1111-4111-8111-111111111111";
const stripeId = "22222222-2222-4222-8222-222222222222";
const theirsId = "33333333-3333-4333-8333-333333333333";

/** A complete app summary; only metadata, as the API returns it. */
function app(index: number, title: string, kind: "dynamic" | "static") {
  return {
    id: `00000000-0000-4000-8000-${String(index).padStart(12, "0")}`,
    slug: title.toLowerCase().replaceAll(" ", "-"),
    title,
    status: kind === "static" ? "live" : "running",
    kind,
    description: "Shared app",
    database: false,
    capabilities: [],
    credentials:
      index === 1
        ? [
            {
              credentialId: slackId,
              name: "slack-bot-token",
              env: "SLACK_BOT_TOKEN",
              version: 2,
              status: "applied",
            },
          ]
        : [],
    url: `http://localhost:8081/app-${index}/`,
    publicUrl: `http://public.apps.test/app-${index}/`,
    visibility: "private",
    release: 1,
    createdAt: new Date(Date.now() - 86_400_000).toISOString(),
    updatedAt: new Date().toISOString(),
    createdBy: { id: "ada", name: "Ada" },
    updatedBy: { id: "ada", name: "Ada" },
  };
}

/** Intercept the app and key endpoints the page uses, recording credential changes. */
async function prepare(context: BrowserContext) {
  const state = {
    apps: [app(1, "Slack bot", "dynamic"), app(2, "Report", "static")],
    requests: [] as { method: string; path: string; body: unknown }[],
    reject: undefined as string | undefined,
  };
  await context.route("**/v1/session", (route) =>
    route.fulfill({
      json: { profile: { subject: "apps-fixture", displayName: "Apps check" } },
    }),
  );
  await context.route("**/v1/settings/teammate-order", (route) =>
    route.fulfill({ json: { teammateIds: [] } }),
  );
  await context.route("**/v1/agents", (route) =>
    route.fulfill({ json: { agents: [] } }),
  );
  await context.route("**/v1/providers", (route) =>
    route.fulfill({ json: { providers: [] } }),
  );
  await context.route("**/v1/keys", (route) =>
    route.fulfill({
      json: {
        keys: [
          {
            id: slackId,
            name: "slack-bot-token",
            type: "generic",
            description: "",
            createdAt: "2026-10-20T00:00:00.000Z",
            updatedAt: "2026-10-21T00:00:00.000Z",
            owned: true,
          },
          {
            id: stripeId,
            name: "stripe-key",
            type: "generic",
            description: "",
            createdAt: "2026-10-20T00:00:00.000Z",
            updatedAt: "2026-10-20T00:00:00.000Z",
            owned: true,
          },
          {
            id: theirsId,
            name: "their-token",
            type: "generic",
            description: "",
            createdAt: "2026-10-20T00:00:00.000Z",
            updatedAt: "2026-10-20T00:00:00.000Z",
            owned: false,
          },
        ],
      },
    }),
  );
  await context.route("**/v1/artifacts**", async (route) => {
    const request = route.request();
    const path = new URL(request.url()).pathname;
    if (request.method() === "GET" && path === "/v1/artifacts") {
      await route.fulfill({ json: { artifacts: state.apps } });
      return;
    }
    const match = path.match(
      /^\/v1\/artifacts\/([^/]+)\/credentials(?:\/(.+))?$/,
    );
    if (!match) {
      await route.fulfill({ status: 404, json: { code: "NOT_FOUND" } });
      return;
    }
    state.requests.push({
      method: request.method(),
      path,
      body: request.postData() ? JSON.parse(request.postData()!) : undefined,
    });
    if (state.reject) {
      await route.fulfill({
        status: 409,
        json: { code: state.reject, message: "Server text never shown" },
      });
      return;
    }
    const target = state.apps.find((item) => item.id === match[1])!;
    if (request.method() === "POST") {
      const body = JSON.parse(request.postData()!) as {
        credentialId: string;
        env: string;
      };
      target.credentials = [
        ...target.credentials,
        {
          credentialId: body.credentialId,
          name: "stripe-key",
          env: body.env,
          version: 1,
          status: "pending",
        },
      ];
    } else
      target.credentials = target.credentials.filter(
        (credential) => credential.env !== decodeURIComponent(match[2]!),
      );
    await route.fulfill({ json: { credentials: target.credentials } });
  });
  return state;
}

test("an app's credentials show names and variables, and attaching sends only an ID and a variable", async ({
  page,
  context,
}, info) => {
  const state = await prepare(context);
  const phone = info.project.name === "phone";
  await page.goto("/apps");
  const card = page.getByRole("article", { name: "Slack bot", exact: true });
  const indicator = card.getByRole("img", { name: "Credentials", exact: true });
  if (phone) await indicator.tap();
  else await indicator.hover();
  await expect(card.getByRole("tooltip")).toHaveText(
    "Credentials: SLACK_BOT_TOKEN ← slack-bot-token (In use).",
  );
  await page.mouse.move(0, 0);
  await expect(
    page
      .getByRole("article", { name: "Report", exact: true })
      .getByRole("button", { name: "Credentials for Report" }),
  ).toHaveCount(0);

  await card
    .getByRole("button", { name: "Credentials for Slack bot", exact: true })
    .click();
  const dialog = page.getByRole("dialog", {
    name: "Credentials for Slack bot",
    exact: true,
  });
  await expect(dialog).toContainText("SLACK_BOT_TOKEN");
  await expect(dialog).toContainText("In use");
  await expect(dialog.getByRole("note")).toContainText(
    "Only attach credentials to apps you trust",
  );
  await expect(dialog.getByRole("note")).toContainText(
    "could send it anywhere, including to its own pages",
  );
  await expect(dialog.getByRole("note")).not.toContainText("never given");
  await dialog
    .getByRole("combobox", { name: "Credential", exact: true })
    .click();
  await expect(
    page.getByRole("option", { name: "their-token", exact: true }),
  ).toHaveCount(0);
  await page.getByRole("option", { name: "stripe-key", exact: true }).click();
  const variable = dialog.getByRole("textbox", {
    name: "Environment variable",
  });
  await expect(variable).toHaveValue("STRIPE_KEY");
  await variable.fill("PGPASSWORD");
  await dialog.getByRole("button", { name: "Attach credential" }).click();
  await expect(dialog).toContainText("Everything sets this name itself");
  expect(state.requests).toEqual([]);

  state.reject = "CREDENTIAL_VARIABLE_CONFLICT";
  await variable.fill("STRIPE_KEY");
  await dialog.getByRole("button", { name: "Attach credential" }).click();
  await expect(dialog.getByRole("alert")).toContainText(
    "ordinary environment variable",
  );
  await expect(dialog).not.toContainText("Server text never shown");

  state.reject = undefined;
  await dialog.getByRole("button", { name: "Attach credential" }).click();
  await expect(dialog).toContainText("Restarting");
  await expect(variable).toHaveValue("");
  expect(state.requests.at(-1)).toEqual({
    method: "POST",
    path: `/v1/artifacts/${state.apps[0]!.id}/credentials`,
    body: { credentialId: stripeId, env: "STRIPE_KEY" },
  });
  if (phone)
    expect(
      await page.evaluate(
        () => document.documentElement.scrollWidth <= innerWidth,
      ),
    ).toBe(true);
  await page.screenshot({
    path: info.outputPath("app-credentials.png"),
    animations: "disabled",
  });

  await dialog
    .getByRole("button", { name: "Remove SLACK_BOT_TOKEN", exact: true })
    .click();
  const confirm = page.getByRole("alertdialog", { name: "Remove credential?" });
  await expect(confirm).toContainText("restarts without it");
  await confirm.getByRole("button", { name: "Remove credential" }).click();
  await expect(confirm).toHaveCount(0);
  await expect(dialog).not.toContainText("SLACK_BOT_TOKEN");
  expect(state.requests.at(-1)).toMatchObject({
    method: "DELETE",
    path: `/v1/artifacts/${state.apps[0]!.id}/credentials/SLACK_BOT_TOKEN`,
  });
});
