import { test, expect, type Page } from "@playwright/test";
import { generateKeyPairSync } from "node:crypto";

/** Sign in at the key deep link and preserve the requested destination. */
async function signIn(page: Page): Promise<void> {
  await page.goto("/keys");
  await page
    .getByLabel("Username", { exact: true })
    .fill(process.env.UI_TEST_USERNAME ?? "owner");
  await page
    .getByLabel("Password", { exact: true })
    .fill(process.env.UI_TEST_PASSWORD ?? "owner");
  await page.getByRole("button", { name: "Sign in", exact: true }).click();
  await expect(
    page.getByRole("heading", { name: "Keys", exact: true }),
  ).toBeVisible();
}

test("uploads, persists, searches, filters, renames and deletes a key without returning its contents", async ({
  page,
}, info) => {
  const material = generateKeyPairSync("rsa", { modulusLength: 2048 })
    .privateKey.export({ type: "pkcs1", format: "pem" })
    .toString();
  const name = `Key check ${crypto.randomUUID().slice(0, 8)}`;
  let id: string | undefined;
  const errors: string[] = [];
  page.on("pageerror", (error) => errors.push(error.message));
  await signIn(page);
  const nav = page.getByRole("navigation", {
    name:
      (page.viewportSize()?.width ?? 1000) < 650
        ? "Mobile workspace"
        : "Workspace",
    exact: true,
  });
  await expect(
    nav.getByRole("link", { name: "Keys", exact: true }),
  ).toHaveAttribute("aria-current", "page");
  const origin = new URL(page.url()).origin;
  try {
    await page.getByRole("button", { name: "Add key", exact: true }).click();
    const dialog = page.getByRole("dialog", { name: "Add key", exact: true });
    await dialog.getByRole("textbox", { name: "Key name" }).fill(name);
    await dialog
      .getByRole("combobox", { name: "Key type", exact: true })
      .click();
    await page.getByRole("option", { name: "SSH", exact: true }).click();
    await dialog.getByLabel("Key file", { exact: true }).setInputFiles({
      name: "development.pem",
      mimeType: "text/plain",
      buffer: Buffer.from(material),
    });
    await expect(
      dialog.getByRole("textbox", { name: "Key contents" }),
    ).toHaveValue(material);
    const creating = page.waitForResponse(
      (response) =>
        response.url().endsWith("/v1/keys") &&
        response.request().method() === "POST",
    );
    await dialog.getByRole("button", { name: "Add key", exact: true }).click();
    const response = await creating;
    expect(response.status()).toBe(201);
    const saved = await response.json();
    id = saved.id;
    expect(Object.keys(saved).sort()).toEqual([
      "availability",
      "createdAt",
      "id",
      "name",
      "type",
    ]);
    expect(saved.availability).toBe("ready");
    await expect(dialog).toHaveCount(0);
    await expect(
      page.getByRole("heading", { name, exact: true }),
    ).toBeVisible();
    await page.reload();
    await expect(
      page.getByRole("heading", { name, exact: true }),
    ).toBeVisible();
    const listing = await page.request.get("/v1/keys");
    expect(listing.headers()["cache-control"]).toBe("no-store");
    const keys = (await listing.json()).keys;
    expect(keys.find((key: { id: string }) => key.id === id)).toEqual(saved);
    await page
      .getByRole("searchbox", { name: "Search keys" })
      .fill(name.toUpperCase());
    await expect(page.locator(".key-card")).toHaveCount(1);
    await expect(page.locator(".key-card")).toContainText(
      "Available to all teammates and Fleet",
    );
    await page.getByRole("combobox", { name: "Filter by type" }).click();
    await page.getByRole("option", { name: "SSH", exact: true }).click();
    await expect(page.locator(".key-card")).toHaveCount(1);
    await page
      .getByRole("searchbox", { name: "Search keys" })
      .fill(`${name}-absent`);
    await expect(
      page.getByText("No matching keys. Try another name or type."),
    ).toBeVisible();
    await page.getByRole("button", { name: "Clear filters" }).click();
    await page
      .getByRole("button", { name: `Rename ${name}`, exact: true })
      .click();
    const renamed = `${name} renamed`;
    await expect(
      page.getByRole("textbox", { name: "Key contents" }),
    ).toHaveCount(0);
    await page.getByRole("textbox", { name: "Key name" }).fill(renamed);
    await page.getByRole("button", { name: "Save name" }).click();
    await expect(
      page.getByRole("heading", { name: renamed, exact: true }),
    ).toBeVisible();
    await page.getByRole("searchbox", { name: "Search keys" }).fill(renamed);
    expect(
      await page.evaluate(
        () => document.documentElement.scrollWidth <= innerWidth,
      ),
    ).toBe(true);
    await page.screenshot({ path: info.outputPath("keys.png") });
    await page
      .getByRole("button", { name: `Delete ${renamed}`, exact: true })
      .click();
    await expect(
      page.getByRole("button", { name: "Cancel", exact: true }),
    ).toBeFocused();
    await page.getByRole("button", { name: "Cancel", exact: true }).click();
    await expect(
      page.getByRole("button", { name: `Delete ${renamed}`, exact: true }),
    ).toBeFocused();
    await page
      .getByRole("button", { name: `Delete ${renamed}`, exact: true })
      .click();
    await page.getByRole("button", { name: "Delete key", exact: true }).click();
    await expect(page.getByRole("alertdialog")).toHaveCount(0);
    await expect(
      page.getByRole("heading", { name: renamed, exact: true }),
    ).toHaveCount(0);
    expect(errors).toEqual([]);
  } finally {
    if (id)
      expect(
        (
          await page.request.delete(`/v1/keys/${id}`, { headers: { origin } })
        ).status(),
      ).toBe(204);
  }
});

test("rejects invalid files and retains a pasted draft after a failed save", async ({
  page,
}) => {
  await signIn(page);
  await page.getByRole("button", { name: "Add key", exact: true }).click();
  const dialog = page.getByRole("dialog", { name: "Add key", exact: true });
  await dialog.getByRole("textbox", { name: "Key name" }).fill("Retry key");
  await dialog.getByLabel("Key file", { exact: true }).setInputFiles({
    name: "large.pem",
    mimeType: "text/plain",
    buffer: Buffer.alloc(32769, "x"),
  });
  await expect(dialog.getByRole("alert")).toContainText("smaller than 32 KB");
  await dialog.getByLabel("Key file", { exact: true }).setInputFiles({
    name: "invalid.txt",
    mimeType: "text/plain",
    buffer: Buffer.from("not a key"),
  });
  await expect(dialog.getByRole("alert")).toContainText(
    "isn’t a supported SSH key format",
  );
  const material = generateKeyPairSync("ed25519")
    .privateKey.export({ type: "pkcs8", format: "pem" })
    .toString();
  await dialog.getByRole("textbox", { name: "Key contents" }).fill(material);
  await page.route("**/v1/keys", async (route) => {
    if (route.request().method() === "POST")
      await route.fulfill({
        status: 503,
        contentType: "application/json",
        body: "{}",
      });
    else await route.continue();
  });
  await dialog.getByRole("button", { name: "Add key", exact: true }).click();
  await expect(dialog.getByRole("alert")).toContainText("try again");
  await expect(
    dialog.getByRole("textbox", { name: "Key contents" }),
  ).toHaveValue(material);
  await expect(dialog.getByRole("textbox", { name: "Key name" })).toHaveValue(
    "Retry key",
  );
  await dialog.getByRole("button", { name: "Cancel" }).click();
  await page.getByRole("button", { name: "Add key", exact: true }).click();
  await expect(page.getByRole("textbox", { name: "Key contents" })).toBeEmpty();
  await page.getByRole("button", { name: "Cancel" }).click();
});

test("a generic credential's value is write-only: it never comes back in responses, the page, or storage", async ({
  page,
}, info) => {
  const marker = `sentinel-ui-${crypto.randomUUID()}`;
  // Leading and trailing spaces, line breaks, quotes, `$`, and Unicode must survive unchanged.
  const value = `  ${marker}\nsecond line $HOME "quoted" 'single' \\ ü 🔑\n  `;
  const replacement = `${marker}-replaced\r\nnext`;
  const name = `credential-check-${crypto.randomUUID().slice(0, 8)}`;
  const bodies: Promise<string>[] = [];
  const errors: string[] = [];
  let id: string | undefined;
  page.on("pageerror", (error) => errors.push(error.message));
  page.on("response", (response) => {
    if (new URL(response.url()).pathname.startsWith("/v1/"))
      bodies.push(response.text().catch(() => ""));
  });
  await signIn(page);
  const origin = new URL(page.url()).origin;
  try {
    await page.getByRole("button", { name: "Add key", exact: true }).click();
    const dialog = page.getByRole("dialog", { name: "Add key", exact: true });
    await dialog.getByRole("textbox", { name: "Key name" }).fill(name);
    await dialog
      .getByRole("combobox", { name: "Key type", exact: true })
      .click();
    await page
      .getByRole("option", { name: "Generic credential", exact: true })
      .click();
    await dialog
      .getByRole("textbox", { name: "Description (optional)" })
      .fill("Slack bot token for checks");
    await dialog.getByRole("textbox", { name: "Value" }).fill(value);
    await expect(dialog.getByRole("textbox", { name: "Value" })).toHaveValue(
      value,
    );
    const creating = page.waitForResponse(
      (response) =>
        response.url().endsWith("/v1/keys") &&
        response.request().method() === "POST",
    );
    await dialog.getByRole("button", { name: "Add key", exact: true }).click();
    const response = await creating;
    expect(response.status()).toBe(201);
    const saved = await response.json();
    id = saved.id;
    expect(saved).toMatchObject({
      name,
      type: "generic",
      description: "Slack bot token for checks",
      owned: true,
    });
    expect(Object.keys(saved)).not.toContain("material");
    await expect(dialog).toHaveCount(0);
    const card = page.locator(".key-card", {
      has: page.getByRole("heading", { name, exact: true }),
    });
    await expect(card).toContainText("Slack bot token for checks");
    await expect(card).toContainText("Added by you");

    await page.getByRole("button", { name: "Add key", exact: true }).click();
    await page
      .getByRole("dialog", { name: "Add key", exact: true })
      .getByRole("combobox", { name: "Key type", exact: true })
      .click();
    await page
      .getByRole("option", { name: "Generic credential", exact: true })
      .click();
    await expect(page.getByRole("textbox", { name: "Value" })).toBeEmpty();
    await page.getByRole("button", { name: "Cancel", exact: true }).click();

    await page
      .getByRole("button", { name: `Edit ${name}`, exact: true })
      .click();
    const editor = page.getByRole("dialog", {
      name: "Edit credential",
      exact: true,
    });
    await expect(editor.getByRole("textbox", { name: "Value" })).toHaveCount(0);
    const renamed = `${name}-renamed`;
    await editor.getByRole("textbox", { name: "Key name" }).fill(renamed);
    await editor
      .getByRole("textbox", { name: "Description (optional)" })
      .fill("Renamed description");
    await editor.getByRole("button", { name: "Save changes" }).click();
    await expect(
      page.getByRole("heading", { name: renamed, exact: true }),
    ).toBeVisible();
    await expect(page.getByText("Renamed description")).toBeVisible();

    await page
      .getByRole("button", { name: `Apps using ${renamed}`, exact: true })
      .click();
    const usage = page.getByRole("dialog", { name: `Apps using ${renamed}` });
    await expect(usage).toContainText("No app uses this credential.");
    await usage.getByRole("button", { name: "Done", exact: true }).click();

    // A listed app shows that saving a new value restarts it.
    await page.route(`**/v1/keys/${id}/apps`, (route) =>
      route.fulfill({
        json: {
          apps: [
            {
              appId: "00000000-0000-4000-8000-000000000001",
              slug: "slack-bot",
              title: "Slack bot",
              env: "SLACK_BOT_TOKEN",
              status: "applied",
            },
          ],
          otherApps: 1,
        },
      }),
    );
    await page
      .getByRole("button", { name: `Replace value of ${renamed}`, exact: true })
      .click();
    const replace = page.getByRole("dialog", {
      name: "Replace value",
      exact: true,
    });
    await expect(replace).toContainText(
      "Saving restarts these apps so they use the new value:",
    );
    await expect(replace).toContainText("Slack bot");
    await expect(replace).toContainText("SLACK_BOT_TOKEN");
    await expect(replace).toContainText("One app of another account");
    await page.unroute(`**/v1/keys/${id}/apps`);
    await replace.getByRole("textbox", { name: "Value" }).fill(replacement);
    const replacing = page.waitForResponse(
      (response) =>
        response.url().endsWith(`/v1/keys/${id}/value`) &&
        response.request().method() === "PUT",
    );
    await replace
      .getByRole("button", { name: "Replace value", exact: true })
      .click();
    expect((await replacing).status()).toBe(200);
    const replaced = page.getByRole("dialog", {
      name: "Value replaced",
      exact: true,
    });
    await expect(replaced).toBeVisible();
    await expect(replaced.getByRole("textbox")).toHaveCount(0);
    expect(
      await page.evaluate(
        () => document.documentElement.scrollWidth <= innerWidth,
      ),
    ).toBe(true);
    await page.screenshot({ path: info.outputPath("credential-replaced.png") });
    await replaced.getByRole("button", { name: "Done", exact: true }).click();

    await page
      .getByRole("button", { name: `Delete ${renamed}`, exact: true })
      .click();
    const deletion = page.getByRole("alertdialog", {
      name: "Delete credential?",
    });
    await expect(deletion).toContainText("No app uses it");
    await expect(
      deletion.getByRole("button", { name: "Cancel", exact: true }),
    ).toBeFocused();
    await deletion
      .getByRole("button", { name: "Delete credential", exact: true })
      .click();
    await expect(deletion).toHaveCount(0);
    await expect(
      page.getByRole("heading", { name: renamed, exact: true }),
    ).toHaveCount(0);
    await expect(page.locator(".key-feedback")).toContainText(
      "Credential deleted.",
    );
    id = undefined;

    const seen = (await Promise.all(bodies)).join("\n");
    expect(seen).not.toContain(marker);
    expect(await page.content()).not.toContain(marker);
    expect(page.url()).not.toContain(marker);
    expect(
      await page.evaluate(() =>
        JSON.stringify([{ ...localStorage }, { ...sessionStorage }]),
      ),
    ).not.toContain(marker);
    expect(errors).toEqual([]);
  } finally {
    if (id)
      expect(
        (
          await page.request.delete(`/v1/keys/${id}`, { headers: { origin } })
        ).status(),
      ).toBe(200);
  }
});
