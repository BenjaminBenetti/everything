import { expect, test } from "@playwright/test";

/** Verify the entire deployed path with a temporary teammate and the owner's connected provider. */
test("live teammate replies using its saved model and remembers the same conversation after reload", async ({
  page,
}, info) => {
  test.setTimeout(180_000);
  await page.goto("/");
  await page.locator("#username").fill(process.env.UI_TEST_USERNAME ?? "owner");
  await page.locator("#password").fill(process.env.UI_TEST_PASSWORD ?? "owner");
  await page.getByRole("button", { name: "Sign in", exact: true }).click();
  await expect(
    page.getByRole("heading", { name: "Welcome back." }),
  ).toBeVisible();
  await expect(page.locator(".shell")).toBeVisible();
  const origin = new URL(page.url()).origin;
  const response = await page.request.get("/v1/providers");
  expect(response.status()).toBe(200);
  const { providers } = (await response.json()) as {
    providers: {
      provider: string;
      model: string | null;
      configured: boolean;
      verifiedAt: string | null;
      status: string;
    }[];
  };
  const active = providers.filter(
    (provider) =>
      provider.configured &&
      provider.verifiedAt &&
      !["error", "disconnected"].includes(provider.status),
  );
  const provider =
    active.find((item) => item.provider === "openai-compatible") ?? active[0];
  test.skip(!provider, "A live chat requires a connected provider.");
  const catalog = await page.request.get(
    `/v1/providers/${provider!.provider}/models`,
  );
  expect(catalog.status()).toBe(200);
  const { models } = (await catalog.json()) as {
    models: { id: string; efforts: string[]; defaultEffort: string }[];
  };
  const model = models.find((item) => item.id === provider!.model) ?? models[0];
  test.skip(!model, "The connected provider must expose a model.");
  const inference = {
    provider: provider!.provider,
    model: model!.id,
    effort: model!.efforts.includes("low") ? "low" : model!.defaultEffort,
  };
  const name = `Chat check ${crypto.randomUUID().slice(0, 8)}`;
  const code = `kiwi-${crypto.randomUUID().slice(0, 8)}`;
  const created = await page.request.post("/v1/agents", {
    headers: { origin },
    data: {
      name,
      systemPrompt:
        "You help with project planning. Keep replies brief and remember details the user shares. Deliver every reply with the send_message tool.",
      avatarId: "avatar-03",
      inference,
    },
  });
  expect(created.status()).toBe(201);
  const { id } = (await created.json()) as { id: string };
  try {
    await page.goto(`/team/${id}`);
    const composer = page.getByRole("textbox", {
      name: `Message ${name}`,
      exact: true,
    });
    await expect(composer).toBeEnabled();
    await composer.fill(
      `Remember that our project code is ${code}. Reply with that code only.`,
    );
    await page.getByRole("button", { name: "Send message" }).click();
    await expect(page.locator(".chat-message.assistant").last()).toContainText(
      code,
      { timeout: 75_000 },
    );
    const before = await page.request.get(`/v1/agents/${id}/runtime`);
    const sessionId = ((await before.json()) as { sessionId: string })
      .sessionId;
    await page.reload();
    await expect(page.locator(".chat-message.assistant").last()).toContainText(
      code,
    );
    await composer.fill(
      "What project code did I ask you to remember? Reply with the code only.",
    );
    await page.getByRole("button", { name: "Send message" }).click();
    await expect(page.locator(".chat-message.assistant")).toHaveCount(2, {
      timeout: 75_000,
    });
    await expect(page.locator(".chat-message.assistant").last()).toContainText(
      code,
    );
    const after = await page.request.get(`/v1/agents/${id}/runtime`);
    expect(((await after.json()) as { sessionId: string }).sessionId).toBe(
      sessionId,
    );
    const history = await page.request.get(`/v1/agents/${id}/messages`);
    const saved = (await history.json()) as {
      messages: { id: string; text: string }[];
      nextCursor: string | null;
    };
    expect(saved.messages).toHaveLength(4);
    expect(saved.nextCursor).toBeNull();
    const earlier = await page.request.get(
      `/v1/agents/${id}/messages?before=${saved.messages[2]!.id}`,
    );
    expect(earlier.status()).toBe(200);
    expect((await earlier.json()).messages).toEqual(saved.messages.slice(0, 2));
    await page.screenshot({ path: info.outputPath("live-teammate-chat.png") });
  } finally {
    await page.request.post(`/v1/agents/${id}/interrupt`, {
      headers: { origin },
    });
    expect(
      (
        await page.request.delete(`/v1/agents/${id}`, { headers: { origin } })
      ).status(),
    ).toBe(204);
  }
});
