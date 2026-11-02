import { expect, test, type BrowserContext } from "@playwright/test";
import { createHash } from "node:crypto";
import { readFile, readdir, writeFile } from "node:fs/promises";
import path from "node:path";

const agentId = "5d0c6a52-8b8e-4c55-9c1a-3f1d2e7b9a10";
const root = process.env.ATTACHMENTS_E2E_ROOT!;
const hash = (bytes: Uint8Array) =>
  createHash("sha256").update(bytes).digest("hex");

/** Unrelated UI records/capabilities are fixtures; uploads/content/messages/runtime/session reach real HTTP. */
async function workspace(context: BrowserContext, origin: string) {
  await context.route("**/*", (route) =>
    ["localhost", "127.0.0.1"].includes(new URL(route.request().url()).hostname)
      ? route.continue()
      : route.abort("blockedbyclient"),
  );
  await context.addCookies([
    {
      name: "everything-session",
      value: "attachments-e2e-session",
      url: origin,
    },
  ]);
  await context.route("**/v1/**", (route) =>
    route.fulfill({
      status: 404,
      json: { code: "NOT_FOUND", message: "Not found" },
    }),
  );
  const json = (pattern: string, body: unknown) =>
    context.route(pattern, (route) => route.fulfill({ json: body }));
  const agent = {
    id: agentId,
    name: "Avery",
    avatarId: "avatar-03",
    systemPrompt: "Help with project files.",
    createdAt: "2026-10-30T09:00:00Z",
    inference: { provider: "anthropic", model: "mocked-model", effort: "high" },
  };
  await json("**/v1/agents", { agents: [agent] });
  await json("**/v1/agents/recent", { agents: [agent] });
  await json("**/v1/providers", { providers: [] });
  await json("**/v1/settings/teammate-order", { teammateIds: [] });
  await json("**/v1/agents/*/model-info", {
    selected: null,
    applied: null,
    selectionError: false,
  });
  await json("**/v1/updates**", {
    updates: [],
    nextCursor: null,
    unread: 0,
    byAgent: {},
  });
  await json("**/v1/agents/*/workspaces", {
    workspaces: [],
    observedAt: "2026-11-02T00:00:00Z",
  });
  await json("**/v1/voice/capabilities", {
    available: false,
    maxDurationMs: 60000,
    maxBytes: 8388608,
    mediaTypes: ["audio/webm"],
    responseTimeoutMs: 195000,
  });
  await context.route("**/v1/agents/*/messages/read", (route) =>
    route.fulfill({ status: 204 }),
  );
  for (const pattern of ["**/v1/session", "**/v1/agents/*/runtime"])
    await context.route(pattern, (route) => route.continue());
  await context.route(/\/v1\/agents\/[^/]+\/messages(?:\?.*)?$/, (route) =>
    route.continue(),
  );
  await context.route(/\/v1\/agents\/[^/]+\/attachments(?:[/?].*)?$/, (route) =>
    route.continue(),
  );
}

test("PNG picker/paste uses original progress, canonical WebP ready/reload/send/history/download and one real stored file", async ({
  page,
  context,
  baseURL,
}, info) => {
  await workspace(context, baseURL!);
  const source = await readFile(path.join(root, "fixtures", "upload.png"));
  const name = info.project.name + "-capture.png";
  const canonical = info.project.name + "-capture.webp";
  let release!: () => void,
    held!: () => void,
    heldOffset = 0;
  const gate = new Promise<void>((resolve) => {
    release = resolve;
  });
  const entered = new Promise<void>((resolve) => {
    held = resolve;
  });
  await context.route(
    /\/attachments\/[^/]+\/content\?offset=/,
    async (route) => {
      const offset = Number(
        new URL(route.request().url()).searchParams.get("offset"),
      );
      const bytes = route.request().postDataBuffer()?.length ?? 0;
      if (offset + bytes === source.length) {
        heldOffset = offset;
        held();
        await gate;
      }
      await route.continue();
    },
  );
  const readyResponse = page.waitForResponse(async (response) => {
    if (
      response.request().method() !== "POST" ||
      !/\/attachments\/[^/]+\/content/.test(response.url()) ||
      response.status() !== 200
    )
      return false;
    return ((await response.json()) as { status?: string }).status === "ready";
  });
  try {
    await page.goto("/team/" + agentId);
    const field = page.getByRole("textbox", {
      name: "Message Avery",
      exact: true,
    });
    const send = page.getByRole("button", {
      name: "Send message",
      exact: true,
    });
    await expect(field).toBeEnabled();
    if (info.project.name === "phone") {
      // Synthetic ClipboardEvent exercises the actual paste handler; not an OS clipboard assertion.
      await field.evaluate(
        (element, data) => {
          const bytes = Uint8Array.from(atob(data.base64), (character) =>
            character.charCodeAt(0),
          );
          const transfer = new DataTransfer();
          transfer.items.add(
            new File([bytes], data.name, { type: "image/png" }),
          );
          element.dispatchEvent(
            new ClipboardEvent("paste", {
              clipboardData: transfer,
              bubbles: true,
              cancelable: true,
            }),
          );
        },
        { name, base64: source.toString("base64") },
      );
    } else
      await page
        .locator('form.chat-composer input[type="file"]')
        .setInputFiles({ name, mimeType: "image/png", buffer: source });
    await entered;
    const progress = page.locator(".chat-attachment-progress");
    await expect(progress).toHaveAttribute("max", String(source.length));
    await expect(progress).toHaveAttribute("value", String(heldOffset));
    await expect(send).toBeDisabled();
    release();
    const response = await readyResponse;
    const ready = (await response.json()) as {
      id: string;
      name: string;
      size: number;
      inputSize: number;
      received: number;
      status: string;
      mediaType: string;
      path: string;
    };
    expect(ready).toMatchObject({
      name: canonical,
      mediaType: "image/webp",
      inputSize: source.length,
      received: source.length,
      status: "ready",
    });
    expect(ready.size).toBeLessThan(source.length);
    const tray = page.getByRole("list", { name: "Files to send" });
    await expect(tray.getByRole("listitem")).toHaveAttribute(
      "data-status",
      "ready",
    );
    await expect(tray).toContainText(canonical);
    await page.reload();
    await expect(tray).toContainText(canonical);
    const natural = await tray.locator("img").evaluate(async (element) => {
      const image = element as HTMLImageElement;
      await image.decode();
      return [image.naturalWidth, image.naturalHeight];
    });
    expect(natural).toEqual([1280, 720]);
    await page.screenshot({
      path: path.join(root, "evidence", info.project.name + "-ready.png"),
      fullPage: true,
    });
    const content = await page.request.get(
      "/v1/agents/" + agentId + "/attachments/" + ready.id + "/content",
    );
    expect(content.status()).toBe(200);
    expect(content.headers()["content-type"]).toBe("image/webp");
    expect(Number(content.headers()["content-length"])).toBe(ready.size);
    expect(content.headers()["content-disposition"]).toContain(canonical);
    const downloaded = await content.body();
    const local = path.join(
      root,
      "workspace-volume",
      path.posix.relative("/workspace", ready.path),
    );
    const stored = await readFile(local);
    expect(downloaded.equals(stored)).toBe(true);
    expect(stored.toString("ascii", 8, 12)).toBe("WEBP");
    expect(await readdir(path.dirname(local))).toEqual([canonical]);
    expect(
      await readdir(path.join(root, "workspace-volume", ".attachment-uploads")),
    ).toEqual([]);
    await field.fill("Inspect the uploaded screenshot");
    await expect(send).toBeEnabled();
    await send.click();
    const sent = page.locator("article.chat-message.user").last();
    await expect(
      sent.getByRole("img", { name: canonical, exact: true }),
    ).toBeVisible();
    await page.reload();
    await expect(
      sent.getByRole("img", { name: canonical, exact: true }),
    ).toBeVisible();
    await expect(sent).toContainText(ready.path);
    await page.screenshot({
      path: path.join(root, "evidence", info.project.name + "-sent.png"),
      fullPage: true,
    });
    const promptFiles = (await readdir(path.join(root, "evidence"))).filter(
      (file) => /^initial-model-input-\d+\.txt$/.test(file),
    );
    const prompts = await Promise.all(
      promptFiles.map((file) =>
        readFile(path.join(root, "evidence", file), "utf8"),
      ),
    );
    const prompt = prompts.find((value) => value.includes(ready.path));
    expect(prompt).toBeDefined();
    expect(prompt!.length).toBeLessThan(4096);
    expect(prompt).not.toMatch(/base64|data:image|iVBORw0KGgo/);
    expect(prompt).not.toContain(stored.toString("base64").slice(0, 80));
    const history = await page.request.get(
      "/v1/agents/" + agentId + "/messages",
    );
    const saved = (
      (await history.json()) as {
        messages: { attachments: { id: string }[] }[];
      }
    ).messages
      .flatMap((item) => item.attachments)
      .find((item) => item.id === ready.id);
    expect(saved).toMatchObject({
      name: canonical,
      path: ready.path,
      size: ready.size,
      mediaType: "image/webp",
    });
    await writeFile(
      path.join(root, "evidence", info.project.name + "-png-webp.json"),
      JSON.stringify(
        {
          sourceBytes: source.length,
          storedBytes: stored.length,
          inputSize: ready.inputSize,
          received: ready.received,
          uploadProgressMax: source.length,
          heldOffset,
          width: 1280,
          height: 720,
          sourceSha256: hash(source),
          storedSha256: hash(stored),
          ready,
          permanentFiles: 1,
          privatePartials: 0,
          allUploadContentSendHistoryHttpReal: true,
          codecReal: true,
          mockScope:
            "Auth, in-memory records, model and unrelated UI routes; external HTTP blocked",
          interaction:
            info.project.name === "phone"
              ? "Synthetic ClipboardEvent through production paste handler"
              : "File input through production picker handler",
        },
        null,
        2,
      ) + "\n",
      { flag: "wx" },
    );
  } finally {
    release?.();
  }
});
