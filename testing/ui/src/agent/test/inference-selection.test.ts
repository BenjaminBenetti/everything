import {
  expect,
  test,
  type BrowserContext,
  type Locator,
  type Page,
} from "@playwright/test";

interface Selection {
  provider: string;
  model: string;
  effort: string;
  speed?: string;
}
interface Teammate {
  id: string;
  name: string;
  systemPrompt: string;
  avatarId: string;
  inference: Selection | null;
  createdAt: string;
}

/** Locate the accessible trigger even while its model settings disclosure is collapsed. */
function dropdown(page: Page, name: string): Locator {
  return page.getByRole("combobox", { name, exact: true, includeHidden: true });
}

/** Choose through the themed menu using its accessible option labels. */
async function choose(
  page: Page,
  field: string,
  option: string,
): Promise<void> {
  await dropdown(page, field).click();
  await page.getByRole("option", { name: option, exact: true }).click();
  await expect(page.getByRole("listbox")).toHaveCount(0);
  await expect(dropdown(page, field)).toBeFocused();
}

/** Inspect available choices and close only the menu, restoring focus to its trigger. */
async function expectChoices(
  page: Page,
  field: string,
  choices: string[],
): Promise<void> {
  await dropdown(page, field).click();
  await expect(page.getByRole("option")).toHaveText(choices);
  await page.keyboard.press("Escape");
  await expect(page.getByRole("listbox")).toHaveCount(0);
  await expect(dropdown(page, field)).toBeFocused();
  await expect(page.getByRole("dialog")).toBeVisible();
}

/** Exercise the real browser UI against deterministic owner-scoped API responses. */
async function workspace(context: BrowserContext, existing?: Selection | null) {
  const providers = [
    {
      provider: "chatgpt",
      configured: true,
      status: "verified",
      verifiedAt: "2026-10-01T00:00:00.000Z",
    },
    {
      provider: "anthropic",
      configured: true,
      status: "error",
      verifiedAt: null,
    },
    {
      provider: "openai-compatible",
      configured: true,
      status: "verified",
      verifiedAt: "2026-10-01T00:00:00.000Z",
    },
  ];
  const state = {
    failSave: false,
    failModels: false,
    saves: [] as Record<string, unknown>[],
    agents: [] as Teammate[],
    extraModels: [] as {
      id: string;
      name: string;
      efforts: string[];
      defaultEffort: string;
      speeds?: string[];
    }[],
    providers,
  };
  if (existing !== undefined)
    state.agents.push({
      id: "selected-teammate",
      name: "Researcher",
      systemPrompt: "Help with research",
      avatarId: "avatar-03",
      inference: existing,
      createdAt: "2026-01-01",
    });
  await context.route("**/v1/session", (route) =>
    route.fulfill({
      json: {
        profile: {
          subject: "inference-browser-fixture",
          displayName: "Model picker",
        },
      },
    }),
  );
  // The sidebar reads the saved teammate order; an empty one keeps creation order.
  await context.route("**/v1/settings/teammate-order", (route) =>
    route.fulfill({ json: { teammateIds: [] } }),
  );
  await context.route("**/v1/providers", (route) =>
    route.fulfill({
      json: {
        providers: state.providers.map((provider) => ({
          baseUrl: null,
          model: null,
          account: null,
          message: null,
          lastCheckedAt: null,
          ...provider,
        })),
      },
    }),
  );
  await context.route("**/v1/providers/*/models", async (route) => {
    if (state.failModels)
      return route.fulfill({
        status: 502,
        json: { message: "Could not load models." },
      });
    const chatgpt = route.request().url().includes("/chatgpt/");
    return route.fulfill({
      json: {
        models: chatgpt
          ? [
              {
                id: "reasoning-model",
                name: "Reasoning model",
                efforts: ["low", "medium", "high"],
                defaultEffort: "medium",
              },
              {
                id: "fast-model",
                name: "Fast model",
                efforts: ["off"],
                defaultEffort: "off",
              },
              ...state.extraModels,
            ]
          : [
              {
                id: "local-model",
                name: "Local model",
                efforts: ["low", "high"],
                defaultEffort: "low",
              },
            ],
      },
    });
  });
  await context.route("**/v1/agents", async (route) => {
    if (route.request().method() === "GET")
      return route.fulfill({ json: { agents: state.agents } });
    const input = route.request().postDataJSON();
    state.saves.push(input);
    if (state.failSave)
      return route.fulfill({
        status: 409,
        json: { message: "The provider is unavailable. Try again." },
      });
    const agent = {
      ...input,
      inference: input.inference ?? null,
      id: "selected-teammate",
      createdAt: "2026-01-01",
    };
    state.agents.push(agent);
    return route.fulfill({ status: 201, json: agent });
  });
  await context.route("**/v1/agents/*", async (route) => {
    expect(route.request().method()).toBe("PATCH");
    const input = route.request().postDataJSON();
    state.saves.push(input);
    if (state.failSave)
      return route.fulfill({
        status: 409,
        json: { message: "The provider is unavailable. Try again." },
      });
    state.agents[0] = { ...state.agents[0]!, ...input };
    return route.fulfill({ json: state.agents[0] });
  });
  // The sidebar reads recent teammates; registered last so it wins over the editing route.
  await context.route("**/v1/agents/recent", (route) =>
    route.fulfill({ json: { agents: [] } }),
  );
  return state;
}

test("creation offers active providers, resets dependent settings, and preserves the draft through avatar selection and failed saves", async ({
  page,
  context,
}, info) => {
  const state = await workspace(context);
  await page.goto("/team");
  await page.getByRole("button", { name: "New teammate", exact: true }).click();
  await page.getByLabel("Teammate name").fill("Model researcher");
  const provider = dropdown(page, "Provider");
  const model = dropdown(page, "Model");
  const effort = dropdown(page, "Effort level");
  const save = page.getByRole("button", {
    name: "Create teammate",
    exact: true,
  });
  const settings = page
    .locator("summary")
    .filter({ hasText: "Model settings" });
  await expect(settings).toContainText("Choose a model (required)");
  await expect(save).toBeDisabled();
  await expect(model).toHaveAttribute("aria-required", "true");
  await page.getByLabel("Teammate name").press("Enter");
  await expect(page.getByRole("dialog")).toBeVisible();
  await expect(provider).toBeHidden();
  await settings.focus();
  await page.keyboard.press("Enter");
  await expect(provider).toBeVisible();
  await expectChoices(page, "Provider", [
    "Choose a provider",
    "ChatGPT",
    "OpenAI-compatible API",
  ]);
  await expect(model).toBeDisabled();
  await expect(effort).toBeDisabled();
  await choose(page, "Provider", "ChatGPT");
  await expect(save).toBeDisabled();
  await choose(page, "Model", "Reasoning model");
  await expectChoices(page, "Effort level", [
    "Choose an effort level",
    "Low",
    "Medium",
    "High",
  ]);
  await choose(page, "Effort level", "High");
  await choose(page, "Provider", "OpenAI-compatible API");
  await expect(model).toHaveText("Choose a model");
  await expect(effort).toHaveText("Choose an effort level");
  await expect(settings).toContainText(/OpenAI-compatible API.*Choose a model/);
  await expect(save).toBeDisabled();
  await choose(page, "Model", "Local model");
  await expect(effort).toHaveText("Low");
  await choose(page, "Provider", "ChatGPT");
  await choose(page, "Model", "Fast model");
  await expect(effort).toHaveText("Default (no effort setting)");
  await expect(
    page.getByText("This model does not expose an adjustable effort level."),
  ).toBeVisible();
  await choose(page, "Model", "Reasoning model");
  await choose(page, "Effort level", "High");
  await settings.click();
  await expect(provider).toBeHidden();
  await expect(settings).toContainText(/ChatGPT.*Reasoning model.*High/);
  await page.screenshot({
    path: info.outputPath("model-settings-collapsed.png"),
  });
  await settings.focus();
  await page.keyboard.press("Space");
  await expect(effort).toBeVisible();
  await expect(effort).toHaveText("High");
  await page.getByRole("button", { name: "Change avatar" }).click();
  await page.getByRole("button", { name: "Back", exact: true }).click();
  await expect(provider).toHaveText("ChatGPT");
  await expect(model).toHaveText("Reasoning model");
  await expect(effort).toHaveText("High");
  state.failSave = true;
  await save.click();
  await expect(page.getByRole("alert")).toContainText(
    "We couldn’t complete that request",
  );
  await expect(effort).toHaveText("High");
  await expect(page.getByLabel("Teammate name")).toHaveValue(
    "Model researcher",
  );
  await page.screenshot({ path: info.outputPath("teammate-inference.png") });
  state.failSave = false;
  await save.click();
  await expect(page.getByRole("dialog")).toHaveCount(0);
  expect(state.saves.at(-1)?.inference).toEqual({
    provider: "chatgpt",
    model: "reasoning-model",
    effort: "high",
  });
  expect(state.saves).toHaveLength(2);
  await page.reload();
  await page
    .getByRole("button", { name: "Edit Model researcher", exact: true })
    .click();
  await expect(provider).toBeHidden();
  await expect(settings).toContainText(/ChatGPT.*Reasoning model.*High/);
  await expect(provider).toHaveText("ChatGPT");
  await expect(model).toHaveText("Reasoning model");
  await expect(effort).toHaveText("High");
});

test("editing saves the full replacement selection and cancelling retains the saved model", async ({
  page,
  context,
}) => {
  const state = await workspace(context, {
    provider: "chatgpt",
    model: "reasoning-model",
    effort: "high",
  });
  await page.goto("/team");
  await page
    .getByRole("button", { name: "Edit Researcher", exact: true })
    .click();
  const settings = page
    .locator("summary")
    .filter({ hasText: "Model settings" });
  await expect(dropdown(page, "Provider")).toBeHidden();
  await expect(settings).toContainText(/ChatGPT.*Reasoning model.*High/);
  await settings.click();
  await expect(dropdown(page, "Effort level")).toHaveText("High");
  await choose(page, "Provider", "OpenAI-compatible API");
  await choose(page, "Model", "Local model");
  await choose(page, "Effort level", "High");
  await page.getByRole("button", { name: "Cancel", exact: true }).click();
  expect(state.saves).toHaveLength(0);
  await page
    .getByRole("button", { name: "Edit Researcher", exact: true })
    .click();
  await expect(dropdown(page, "Provider")).toBeHidden();
  await expect(settings).toContainText(/ChatGPT.*Reasoning model.*High/);
  await settings.click();
  await expect(dropdown(page, "Provider")).toHaveText("ChatGPT");
  await choose(page, "Provider", "OpenAI-compatible API");
  await choose(page, "Model", "Local model");
  await choose(page, "Effort level", "High");
  await settings.click();
  await expect(settings).toContainText(
    /OpenAI-compatible API.*Local model.*High/,
  );
  await page.getByRole("button", { name: "Save changes", exact: true }).click();
  await expect(page.getByRole("dialog")).toHaveCount(0);
  expect(state.saves[0]?.inference).toEqual({
    provider: "openai-compatible",
    model: "local-model",
    effort: "high",
  });
  await page
    .getByRole("button", { name: "View Researcher", exact: true })
    .click();
  await expect(page.getByRole("dialog")).toContainText("OpenAI-compatible API");
  await expect(page.getByRole("dialog")).toContainText("local-model");
  await expect(page.getByRole("dialog")).toContainText("High");
});

test("an unavailable saved provider stays out of the picker and profile edits retain its selection", async ({
  page,
  context,
}) => {
  const state = await workspace(context, {
    provider: "anthropic",
    model: "saved-claude",
    effort: "high",
  });
  await page.goto("/team");
  await page
    .getByRole("button", { name: "Edit Researcher", exact: true })
    .click();
  await expect(page.locator("summary")).toContainText(
    /Claude.*saved-claude.*High/,
  );
  await page.getByText("Model settings", { exact: true }).click();
  await expect(
    page.getByText(/The saved provider, Claude, is unavailable/),
  ).toBeVisible();
  await expectChoices(page, "Provider", [
    "Choose a provider",
    "ChatGPT",
    "OpenAI-compatible API",
  ]);
  await page.getByLabel("Teammate name").fill("Renamed");
  await page.getByRole("button", { name: "Save changes", exact: true }).click();
  await expect(page.getByRole("dialog")).toHaveCount(0);
  expect(state.saves[0]).not.toHaveProperty("inference");
  expect(state.agents[0]?.inference?.model).toBe("saved-claude");
});

test("existing teammates without a model can still edit their profile", async ({
  page,
  context,
}) => {
  const state = await workspace(context, null);
  await page.goto("/team");
  await page
    .getByRole("button", { name: "Edit Researcher", exact: true })
    .click();
  await expect(page.locator("summary")).toContainText("Not set");
  await page.getByLabel("Teammate name").fill("Renamed teammate");
  await page.getByRole("button", { name: "Save changes", exact: true }).click();
  await expect(page.getByRole("dialog")).toHaveCount(0);
  expect(state.saves).toHaveLength(1);
  expect(state.saves[0]).not.toHaveProperty("inference");
  expect(state.agents[0]?.inference).toBeNull();
});

test("model loading failures can be retried without losing the teammate draft", async ({
  page,
  context,
}) => {
  const state = await workspace(context);
  state.failModels = true;
  await page.goto("/team");
  await page.getByRole("button", { name: "New teammate", exact: true }).click();
  await page.getByLabel("Teammate name").fill("Draft");
  await page.getByText("Model settings", { exact: true }).click();
  await choose(page, "Provider", "ChatGPT");
  await expect(page.getByRole("alert")).toContainText("Could not load models");
  await expect(
    page.getByRole("button", { name: "Create teammate", exact: true }),
  ).toBeDisabled();
  state.failModels = false;
  await page.getByRole("button", { name: "Retry models", exact: true }).click();
  await choose(page, "Model", "Reasoning model");
  await expect(page.getByLabel("Teammate name")).toHaveValue("Draft");
  await expect(
    page.getByRole("button", { name: "Create teammate", exact: true }),
  ).toBeEnabled();
});

test("without active providers the editor explains setup and offers no unavailable choices", async ({
  page,
  context,
}) => {
  const state = await workspace(context);
  for (const provider of state.providers) {
    provider.configured = false;
    provider.status = "disconnected";
    provider.verifiedAt = null;
  }
  await page.goto("/team");
  await page.getByRole("button", { name: "New teammate", exact: true }).click();
  await page.getByLabel("Teammate name").fill("Needs a model");
  await expect(
    page.getByRole("button", { name: "Create teammate", exact: true }),
  ).toBeDisabled();
  await page.getByText("Model settings", { exact: true }).click();
  await expect(
    page.getByText(/Connect and check a provider in Model providers/),
  ).toBeVisible();
  await expectChoices(page, "Provider", ["Choose a provider"]);
  await expect(dropdown(page, "Model")).toBeDisabled();
  await expect(dropdown(page, "Effort level")).toBeDisabled();
});

test("dropdown keyboard navigation, typeahead, dismissal, and clearing preserve the teammate dialog", async ({
  page,
  context,
}) => {
  await workspace(context);
  await page.goto("/team");
  await page.getByRole("button", { name: "New teammate", exact: true }).click();
  await page.getByLabel("Teammate name").fill("Keyboard teammate");
  await page.getByText("Model settings", { exact: true }).click();
  await dropdown(page, "Provider").focus();
  await page.keyboard.press("ArrowDown");
  await expect(
    page.getByRole("listbox", { name: "Provider", exact: true }),
  ).toBeVisible();
  await page.keyboard.press("End");
  await expect(
    page.getByRole("option", { name: "OpenAI-compatible API", exact: true }),
  ).toBeFocused();
  await page.keyboard.press("Enter");
  await expect(dropdown(page, "Provider")).toHaveText("OpenAI-compatible API");
  await choose(page, "Provider", "ChatGPT");
  await expect(dropdown(page, "Model")).toBeEnabled();
  await dropdown(page, "Model").focus();
  await expect(dropdown(page, "Model")).toBeFocused();
  await page.keyboard.press("ArrowDown");
  await expect(
    page.getByRole("listbox", { name: "Model", exact: true }),
  ).toBeVisible();
  await page.keyboard.press("f");
  await expect(
    page.getByRole("option", { name: "Fast model", exact: true }),
  ).toBeFocused();
  await page.keyboard.press("Enter");
  await expect(dropdown(page, "Model")).toHaveText("Fast model");
  await expect(dropdown(page, "Effort level")).toHaveText(
    "Default (no effort setting)",
  );
  await dropdown(page, "Model").click();
  await expect(
    page.getByRole("option", { name: "Fast model", exact: true }),
  ).toHaveAttribute("aria-selected", "true");
  await page.keyboard.press("Escape");
  await expect(dropdown(page, "Model")).toBeFocused();
  await expect(page.getByRole("dialog")).toBeVisible();
  await choose(page, "Model", "Choose a model");
  await expect(dropdown(page, "Effort level")).toHaveText(
    "Choose an effort level",
  );
  await expect(
    page.getByRole("button", { name: "Create teammate", exact: true }),
  ).toBeDisabled();
  await choose(page, "Provider", "Choose a provider");
  await expect(page.locator("summary")).toContainText(
    "Choose a model (required)",
  );
  await expect(
    page.getByRole("button", { name: "Create teammate", exact: true }),
  ).toBeDisabled();
});

test("dropdown menus follow every theme and keep long model catalogs within the screen", async ({
  page,
  context,
}, info) => {
  const state = await workspace(context);
  state.extraModels = Array.from({ length: 20 }, (_, index) => ({
    id: `extended-model-${index + 1}`,
    name: `Research model with a longer descriptive name for extended coding tasks ${index + 1}`,
    efforts: ["off"],
    defaultEffort: "off",
  }));
  for (const theme of [
    "midnight",
    "midnight-dimmed",
    "graphite",
    "graphite-dimmed",
    "daylight",
    "sand",
    "solarized-light",
    "solarized-dark",
    "gruvbox-dark-soft",
    "gruvbox-dark-medium",
    "gruvbox-dark-hard",
    "gruvbox-light-soft",
    "gruvbox-light-medium",
    "gruvbox-light-hard",
  ]) {
    await page.goto(`/team?theme=${theme}`);
    await expect(page.locator("html")).toHaveAttribute("data-theme", theme);
    await page
      .getByRole("button", { name: "New teammate", exact: true })
      .click();
    await page.getByText("Model settings", { exact: true }).click();
    await choose(page, "Provider", "ChatGPT");
    await choose(page, "Model", "Reasoning model");
    await dropdown(page, "Model").click();
    const menu = page.getByRole("listbox", { name: "Model", exact: true });
    await expect(menu).toBeVisible();
    const background = await dropdown(page, "Model").evaluate(
      (element) => getComputedStyle(element).backgroundColor,
    );
    const foreground = await page
      .locator("html")
      .evaluate((element) => getComputedStyle(element).color);
    await expect(menu).toHaveCSS("background-color", background);
    await expect(menu).toHaveCSS("color", foreground);
    const bounds = await menu.boundingBox();
    expect(bounds).not.toBeNull();
    expect(bounds!.x).toBeGreaterThanOrEqual(0);
    expect(bounds!.y).toBeGreaterThanOrEqual(0);
    expect(bounds!.x + bounds!.width).toBeLessThanOrEqual(
      page.viewportSize()!.width,
    );
    expect(bounds!.y + bounds!.height).toBeLessThanOrEqual(
      page.viewportSize()!.height,
    );
    if (
      [
        "midnight",
        "sand",
        "solarized-light",
        "solarized-dark",
        "gruvbox-dark-medium",
        "gruvbox-light-medium",
      ].includes(theme)
    )
      await page.screenshot({ path: info.outputPath(`dropdown-${theme}.png`) });
    await page.keyboard.press("End");
    const last = page.getByRole("option", {
      name: state.extraModels.at(-1)!.name,
      exact: true,
    });
    await expect(last).toBeFocused();
    await expect(last).toBeInViewport();
    await page.keyboard.press("Enter");
    await expect(dropdown(page, "Model")).toHaveText(
      state.extraModels.at(-1)!.name,
    );
  }
});

test("Fast mode is offered only on models that list it, starts off with a usage warning, saves the request, and turns off for other models", async ({
  page,
  context,
}) => {
  const state = await workspace(context, {
    provider: "chatgpt",
    model: "reasoning-model",
    effort: "high",
  });
  state.extraModels = [
    {
      id: "sol-model",
      name: "Sol model",
      efforts: ["low", "high"],
      defaultEffort: "low",
      speeds: ["standard", "fast"],
    },
  ];
  await page.goto("/team");
  const dialog = page.getByRole("dialog");
  const settings = page
    .locator("summary")
    .filter({ hasText: "Model settings" });
  const fast = dialog.getByRole("switch", {
    name: "Request Fast mode",
    exact: true,
  });
  const save = page.getByRole("button", { name: "Save changes", exact: true });
  const edit = page.getByRole("button", {
    name: "Edit Researcher",
    exact: true,
  });
  await edit.click();
  await settings.click();
  await expect(dropdown(page, "Effort level")).toHaveText("High");
  // Models without Fast mode, including catalogs that list no speeds, show no switch.
  await expect(fast).toHaveCount(0);
  await choose(page, "Model", "Sol model");
  await expect(fast).toBeVisible();
  await expect(fast).not.toBeChecked();
  await expect(dialog).toContainText(
    "It uses your plan or credits faster, or costs more",
  );
  await expect(settings).not.toContainText("Fast requested");
  await dialog.getByText("Request Fast mode", { exact: true }).click();
  await expect(fast).toBeChecked();
  await expect(settings).toContainText(
    /ChatGPT.*Sol model.*Low.*Fast requested/,
  );
  await save.click();
  await expect(dialog).toHaveCount(0);
  expect(state.saves.at(-1)?.inference).toEqual({
    provider: "chatgpt",
    model: "sol-model",
    effort: "low",
    speed: "fast",
  });
  await page
    .getByRole("button", { name: "View Researcher", exact: true })
    .click();
  await expect(dialog).toContainText("Fast mode requested");
  await page.getByRole("button", { name: "Edit", exact: true }).click();
  await expect(settings).toContainText("Fast requested");
  await settings.click();
  await expect(fast).toBeChecked();
  // Choosing a model without Fast mode removes the switch and the saved request.
  await choose(page, "Model", "Reasoning model");
  await expect(fast).toHaveCount(0);
  await expect(settings).not.toContainText("Fast requested");
  await choose(page, "Effort level", "High");
  await save.click();
  await expect(dialog).toHaveCount(0);
  expect(state.saves.at(-1)?.inference).toEqual({
    provider: "chatgpt",
    model: "reasoning-model",
    effort: "high",
  });
  // A saved request on a model that no longer offers Fast mode stays visible until turned off.
  state.agents[0] = {
    ...state.agents[0]!,
    inference: {
      provider: "chatgpt",
      model: "reasoning-model",
      effort: "high",
      speed: "fast",
    },
  };
  await page.reload();
  await edit.click();
  await settings.click();
  await expect(fast).toBeChecked();
  await expect(dialog).toContainText(
    "Fast mode isn’t available for this model.",
  );
  await dialog.getByText("Request Fast mode", { exact: true }).click();
  await expect(fast).toHaveCount(0);
  await expect(dialog).not.toContainText("Fast mode isn’t available");
  await save.click();
  await expect(dialog).toHaveCount(0);
  expect(state.saves.at(-1)?.inference).toEqual({
    provider: "chatgpt",
    model: "reasoning-model",
    effort: "high",
  });
});
