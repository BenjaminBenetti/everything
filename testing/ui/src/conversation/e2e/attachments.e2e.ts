import { expect, test, type BrowserContext, type Page } from "@playwright/test";
import { createHash } from "node:crypto";
import { mkdir, readFile, readdir, writeFile } from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { crc32, deflateSync } from "node:zlib";

/** The teammate the attachment gateway serves. */
const agentId = "5d0c6a52-8b8e-4c55-9c1a-3f1d2e7b9a10";

/** The gateway's folder, holding its temporary workspace volume and what the mocked model received. */
const root = process.env.ATTACHMENTS_E2E_ROOT!;

/** Screenshots and the delivery record kept as evidence, outside Playwright's cleared output folder. */
const evidence = fileURLToPath(
  new URL(
    "../../../../../.local/ui-test-results/attachments-e2e-evidence/",
    import.meta.url,
  ),
);

/** A synthetic RGBA PNG: a soft gradient with a grid, so previews are recognizable. */
function png(width: number, height: number): Buffer {
  const chunk = (type: string, data: Buffer) => {
    const length = Buffer.alloc(4);
    length.writeUInt32BE(data.length);
    const body = Buffer.concat([Buffer.from(type, "ascii"), data]);
    const checksum = Buffer.alloc(4);
    checksum.writeUInt32BE(crc32(body));
    return Buffer.concat([length, body, checksum]);
  };
  const header = Buffer.alloc(13);
  header.writeUInt32BE(width, 0);
  header.writeUInt32BE(height, 4);
  header.set([8, 6, 0, 0, 0], 8);
  const rows: Buffer[] = [];
  for (let y = 0; y < height; y++) {
    const row = Buffer.alloc(1 + width * 4);
    for (let x = 0; x < width; x++) {
      const grid = x % 40 === 0 || y % 40 === 0;
      row.set(
        grid
          ? [255, 255, 255, 255]
          : [60 + (x * 120) / width, 110 + (y * 100) / height, 200, 255],
        1 + x * 4,
      );
    }
    rows.push(row);
  }
  return Buffer.concat([
    Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]),
    chunk("IHDR", header),
    chunk("IDAT", deflateSync(Buffer.concat(rows))),
    chunk("IEND", Buffer.alloc(0)),
  ]);
}

/** Deterministic bytes that are neither text nor an image. */
function binary(size: number, seed: string): Buffer {
  const parts: Buffer[] = [];
  let block = createHash("sha256").update(seed).digest();
  for (let length = 0; length < size; length += block.length) {
    parts.push(block);
    block = createHash("sha256").update(block).digest();
  }
  return Buffer.concat(parts).subarray(0, size);
}

/** Synthetic files only; nothing here comes from a real user. */
const files = {
  image: {
    name: "whiteboard sketch.png",
    mimeType: "image/png",
    buffer: png(640, 360),
  },
  text: {
    name: "Q3 signups.csv",
    mimeType: "text/csv",
    buffer: Buffer.from("week,signups\n1,120\n2,164\n3,201\n"),
  },
  binary: {
    name: "sensor-dump.bin",
    mimeType: "application/octet-stream",
    buffer: binary(5 * 1024 * 1024 + 123, "sensor-dump"),
  },
  empty: { name: "empty.txt", mimeType: "text/plain", buffer: Buffer.alloc(0) },
};

/**
 * Sign in with the gateway's test session and mock the chat page's unrelated routes. Session,
 * runtime status, messages, and attachments reach the real gateway.
 */
async function workspace(context: BrowserContext, baseURL: string) {
  await context.addCookies([
    {
      name: "everything-session",
      value: "attachments-e2e-session",
      url: baseURL,
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
  const teammate = {
    id: agentId,
    name: "Avery",
    avatarId: "avatar-03",
    systemPrompt: "Help with project files.",
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
  await context.route("**/v1/agents/*/messages/read", (route) =>
    route.fulfill({ status: 204 }),
  );
  const real = (route: Parameters<Parameters<typeof context.route>[1]>[0]) =>
    route.continue();
  await context.route("**/v1/session", real);
  await context.route("**/v1/agents/*/runtime", real);
  await context.route(/\/v1\/agents\/[^/]+\/messages(?:\?.*)?$/, real);
  await context.route(/\/v1\/agents\/[^/]+\/attachments(?:[/?].*)?$/, real);
}

/** Slow each uploaded part a little, as a slower connection would, so progress is visible. */
async function slowParts(context: BrowserContext, milliseconds: number) {
  await context.route(
    /\/attachments\/[^/]+\/content\?offset=/,
    async (route) => {
      await new Promise((resolve) => setTimeout(resolve, milliseconds));
      await route.continue();
    },
  );
}

/** Files the gateway placed in the teammate's workspace, by runtime path, with their bytes. */
async function workspaceFiles(): Promise<Map<string, Buffer>> {
  const base = path.join(root, "workspace-volume", agentId, "attachments");
  const found = new Map<string, Buffer>();
  for (const id of await readdir(base).catch(() => []))
    for (const name of await readdir(path.join(base, id)))
      found.set(
        `/workspace/${agentId}/attachments/${id}/${name}`,
        await readFile(path.join(base, id, name)),
      );
  return found;
}

/** The most recent input the mocked model received. */
async function latestModelInput(): Promise<string> {
  const folder = path.join(root, "evidence");
  const inputs = (await readdir(folder))
    .filter((name) => name.startsWith("initial-model-input-"))
    .sort((a, b) => Number(a.match(/\d+/)![0]) - Number(b.match(/\d+/)![0]));
  return readFile(path.join(folder, inputs.at(-1)!), "utf8");
}

/** The open chat's composer and its controls. */
function composer(page: Page) {
  return {
    field: page.getByRole("textbox", { name: "Message Avery", exact: true }),
    attach: page.getByRole("button", { name: "Attach files", exact: true }),
    send: page.getByRole("button", { name: "Send message", exact: true }),
    tray: page.getByRole("list", { name: "Files to send" }),
    picker: page.locator('form.chat-composer input[type="file"]'),
  };
}

test("@desktop files upload into the teammate's workspace and only their paths reach the model", async ({
  page,
  context,
  baseURL,
}) => {
  await mkdir(evidence, { recursive: true });
  await workspace(context, baseURL!);
  await slowParts(context, 700);
  await page.goto(`/team/${agentId}`);
  const chat = composer(page);
  await expect(chat.field).toBeEnabled();
  await expect(chat.attach).toBeEnabled();

  await chat.picker.setInputFiles([
    files.image,
    files.text,
    files.binary,
    files.empty,
  ]);
  await expect(chat.tray.getByRole("listitem")).toHaveCount(4);
  // Sending waits for every file; the screenshot shows progress while parts upload.
  await expect(page.locator(".chat-attachment-progress").first()).toBeVisible();
  await expect(chat.send).toBeDisabled();
  await expect(
    page.getByRole("status").filter({ hasText: "Uploading files" }),
  ).toBeVisible();
  await page.screenshot({ path: `${evidence}desktop-1-uploading.png` });

  await expect(chat.tray.getByText("ready to send")).toHaveCount(4, {
    timeout: 30_000,
  });
  await chat.field.fill("Can you check the sketch against the signups?");
  await expect(chat.send).toBeEnabled();
  await page.screenshot({ path: `${evidence}desktop-2-ready.png` });

  await chat.send.click();
  const sent = page.locator("article.chat-message.user").last();
  await expect(
    sent.getByRole("list", { name: "Attached files" }),
  ).toBeVisible();
  await expect(sent.getByRole("img", { name: files.image.name })).toBeVisible();
  await expect(
    sent.getByRole("link", { name: new RegExp(`Download ${files.text.name}`) }),
  ).toBeVisible();
  await expect(page.getByText("(Mocked model reply.)").last()).toBeVisible();
  await expect(chat.tray).toHaveCount(0);
  await page.screenshot({ path: `${evidence}desktop-3-sent.png` });

  // The files are in the teammate's workspace with exactly the bytes chosen.
  const saved = await workspaceFiles();
  const byName = (suffix: string) =>
    [...saved.entries()].find(([location]) => location.endsWith(suffix));
  expect(byName("/whiteboard_sketch.png")?.[1].equals(files.image.buffer)).toBe(
    true,
  );
  expect(byName("/Q3_signups.csv")?.[1].equals(files.text.buffer)).toBe(true);
  expect(byName("/sensor-dump.bin")?.[1].equals(files.binary.buffer)).toBe(
    true,
  );
  expect(byName("/empty.txt")?.[1].length).toBe(0);

  // The model's initial input names each server path and carries no file contents.
  const input = await latestModelInput();
  for (const location of saved.keys()) expect(input).toContain(location);
  expect(input).not.toMatch(/base64|iVBORw0KGgo|week,signups/);
  expect(input.length).toBeLessThan(2000);
  await writeFile(
    `${evidence}delivery.json`,
    JSON.stringify(
      {
        note: "Synthetic files; mocked sign-in, in-memory records, and mocked model. Uploads, storage, sending, and model input use the shipped code.",
        initialModelInput: input,
        workspaceFiles: [...saved].map(([location, bytes]) => ({
          path: location,
          bytes: bytes.length,
          sha256: createHash("sha256").update(bytes).digest("hex"),
        })),
      },
      null,
      2,
    ),
  );

  // History, attachments included, returns after a reload.
  await page.reload();
  const reloaded = page.locator("article.chat-message.user").last();
  await expect(
    reloaded.getByRole("img", { name: files.image.name }),
  ).toBeVisible();
  await expect(
    reloaded.getByText(`/workspace/${agentId}/attachments/`).first(),
  ).toBeVisible();
  await page.screenshot({ path: `${evidence}desktop-4-after-reload.png` });
});

test("@desktop dropped files attach, can be removed, and a message can be only files", async ({
  page,
  context,
  baseURL,
}) => {
  await workspace(context, baseURL!);
  await page.goto(`/team/${agentId}`);
  const chat = composer(page);
  await expect(chat.field).toBeEnabled();
  const dropped = await page.evaluateHandle(
    ([name, bytes]) => {
      const transfer = new DataTransfer();
      transfer.items.add(
        new File([new Uint8Array(bytes)], name, { type: "text/plain" }),
      );
      return transfer;
    },
    [
      "dropped notes.txt",
      [...Buffer.from("dropped by drag and drop\n")],
    ] as const,
  );
  const form = page.locator("form.chat-composer");
  await form.dispatchEvent("dragover", { dataTransfer: dropped });
  await expect(form).toHaveAttribute("data-dragging", "true");
  await form.dispatchEvent("drop", { dataTransfer: dropped });
  await expect(chat.tray.getByText("ready to send")).toHaveCount(1);
  await chat.picker.setInputFiles([files.text]);
  await expect(chat.tray.getByText("ready to send")).toHaveCount(2);
  await chat.tray
    .getByRole("button", { name: `Remove ${files.text.name}` })
    .click();
  await expect(chat.tray.getByRole("listitem")).toHaveCount(1);
  await expect(chat.field).toHaveValue("");
  await chat.send.click();
  const sent = page.locator("article.chat-message.user").last();
  await expect(
    sent.getByRole("link", { name: /Download dropped notes\.txt/ }),
  ).toBeVisible();
  await expect(sent.locator(".message-markdown")).toHaveCount(0);
  expect(await latestModelInput()).toMatch(/^<attachments>/);
});

test("@phone attachments are usable on a phone, before and after sending", async ({
  page,
  context,
  baseURL,
}) => {
  await mkdir(evidence, { recursive: true });
  await workspace(context, baseURL!);
  await slowParts(context, 900);
  await page.goto(`/team/${agentId}`);
  const chat = composer(page);
  await expect(chat.field).toBeEnabled();
  await chat.picker.setInputFiles([files.image, files.binary]);
  await expect(page.locator(".chat-attachment-progress").first()).toBeVisible();
  await expect(chat.send).toBeDisabled();
  await page.screenshot({ path: `${evidence}phone-1-uploading.png` });
  await expect(chat.tray.getByText("ready to send")).toHaveCount(2, {
    timeout: 30_000,
  });
  await chat.field.fill("From my phone");
  await page.screenshot({ path: `${evidence}phone-2-ready.png` });
  await chat.send.click();
  const sent = page.locator("article.chat-message.user").last();
  await expect(sent.getByRole("img", { name: files.image.name })).toBeVisible();
  await expect(page.getByText("(Mocked model reply.)").last()).toBeVisible();
  // Nothing overflows the phone's width.
  expect(
    await page.evaluate(
      () => document.documentElement.scrollWidth <= window.innerWidth,
    ),
  ).toBe(true);
  await page.screenshot({ path: `${evidence}phone-3-sent.png` });
});
