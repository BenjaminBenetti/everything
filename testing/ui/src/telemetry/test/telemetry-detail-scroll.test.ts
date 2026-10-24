import { fileURLToPath } from "node:url";
import { expect, test, type Page } from "@playwright/test";
import {
  longRecords,
  longTrace,
  telemetryWorkspace,
  type TelemetryWorkspace,
} from "../fixture/telemetry-workspace.js";

/** Where named screenshots of the synthetic layouts are kept as evidence. */
const evidence = fileURLToPath(
  new URL(
    "../../../../../.local/ui-test-results/telemetry-detail-evidence/",
    import.meta.url,
  ),
);

/** Prompts in the synthetic trace; each has a provider request beneath it. */
const depth = 30;

/** The provider request span a synthetic record belongs to: deep in the trace for most records. */
function spanOf(index: number): string {
  return `3${String(depth - (index % 8)).padStart(15, "0")}`;
}

/** A long, multi-line error text, so the details above the trace are tall as well. */
const longMessage = Array.from(
  { length: 30 },
  (_, line) => `Synthetic provider explanation, line ${line + 1}.`,
).join("\n");

/** Desktop sizes: wide, short, and narrower than the two-column layout's breakpoint. */
const viewports = [
  { name: "wide", width: 1440, height: 960 },
  { name: "short", width: 1440, height: 640 },
  { name: "narrow", width: 1100, height: 800 },
  { name: "narrow-short", width: 900, height: 700 },
] as const;

/** Forty failures in one deep trace, with long error text, as the page will show them. */
async function longWorkspace(page: Page): Promise<TelemetryWorkspace> {
  const workspace = await telemetryWorkspace(page.context());
  workspace.eventPages.set("", {
    records: longRecords(40, spanOf),
    nextCursor: null,
  });
  workspace.trace = longTrace(depth);
  workspace.eventDetail = { message: longMessage, textWithheld: false };
  return workspace;
}

/** Positions and scroll offsets the user sees, measured in the browser. */
interface Geometry {
  readonly content: { top: number; bottom: number; scrollTop: number };
  readonly documentScrollTop: number;
  readonly panel: { top: number; bottom: number } | null;
  readonly header: { top: number; bottom: number } | null;
  /** The panel's own scrolling area, if its content overflows one. */
  readonly scroller: {
    top: number;
    bottom: number;
    scrollTop: number;
    maxScrollTop: number;
  } | null;
  /** The selected record's span in the trace. */
  readonly target: {
    top: number;
    bottom: number;
    expanded: boolean;
    title: string;
  } | null;
}

/** Measure the page: the content area, the details panel, its scrolling area, and the target. */
function geometry(page: Page): Promise<Geometry> {
  return page.evaluate(() => {
    const box = (element: Element | null | undefined) => {
      if (!element) return null;
      const rect = element.getBoundingClientRect();
      return { top: rect.top, bottom: rect.bottom };
    };
    const content = document.getElementById("workspace-content")!;
    const panel = document.getElementById("telemetry-detail");
    const scroller = panel
      ? [panel, ...panel.querySelectorAll("*")].find(
          (element) =>
            /(auto|scroll)/.test(getComputedStyle(element).overflowY) &&
            element.scrollHeight > element.clientHeight + 1,
        )
      : undefined;
    const target = panel?.querySelector(".telemetry-span.highlighted");
    return {
      content: {
        ...box(content)!,
        scrollTop: content.scrollTop,
      },
      documentScrollTop: document.scrollingElement?.scrollTop ?? 0,
      panel: box(panel),
      header: box(panel?.querySelector(".telemetry-detail-header")),
      scroller: scroller
        ? {
            ...box(scroller)!,
            scrollTop: scroller.scrollTop,
            maxScrollTop: scroller.scrollHeight - scroller.clientHeight,
          }
        : null,
      target: target
        ? {
            ...box(target)!,
            expanded:
              target
                .querySelector(".telemetry-span-button")
                ?.getAttribute("aria-expanded") === "true",
            title:
              target.querySelector(".telemetry-span-name")?.textContent ?? "",
          }
        : null,
    };
  });
}

/** Where the row of the record with `index` is on screen. */
function rowTop(page: Page, index: number): Promise<number> {
  return page.evaluate(
    (title) =>
      [...document.querySelectorAll(".telemetry-title")]
        .find((element) => element.textContent === title)!
        .getBoundingClientRect().top,
    `Model request failed ${index}`,
  );
}

/** Scroll the results so the record with `index` is a third of the way down, as a reader would. */
async function scrollListTo(page: Page, index: number): Promise<number> {
  return page.evaluate((title) => {
    const content = document.getElementById("workspace-content")!;
    const row = [...document.querySelectorAll(".telemetry-title")].find(
      (element) => element.textContent === title,
    )!;
    const offset =
      row.getBoundingClientRect().top - content.getBoundingClientRect().top;
    content.scrollTop += offset - content.clientHeight / 3;
    return content.scrollTop;
  }, `Model request failed ${index}`);
}

/** The list row of the record with `index`. */
function row(page: Page, index: number) {
  return page.getByRole("button", {
    name: new RegExp(`Model request failed ${index}\\b`),
  });
}

/**
 * The details fit the content area, scroll inside themselves, keep their header in view, and show
 * the selected record's span, expanded, while the chosen row stays where it was on screen. When
 * opening the details narrows the list, its rows reflow and the content area scrolls to keep the
 * chosen row in place, so the row's position, not the scroll offset, is what must not move.
 */
async function expectContainedAndRevealed(
  page: Page,
  chosen: { index: number; top: number },
  title: string,
): Promise<Geometry> {
  await expect
    .poll(async () => (await geometry(page)).target?.title)
    .toBe(title);
  await expect
    .poll(async () => {
      const { scroller, target } = await geometry(page);
      return !!scroller && !!target && target.top >= scroller.top - 1;
    })
    .toBe(true);
  const measured = await geometry(page);
  const { content, panel, header, scroller, target } = measured;
  expect(
    Math.abs((await rowTop(page, chosen.index)) - chosen.top),
    "the chosen row stayed where it was on screen",
  ).toBeLessThan(1);
  expect(measured.documentScrollTop).toBe(0);
  expect(panel, "the details are open").not.toBeNull();
  expect(panel!.top).toBeGreaterThanOrEqual(content.top - 1);
  expect(
    panel!.bottom,
    "the details end within the content area",
  ).toBeLessThanOrEqual(content.bottom + 1);
  expect(scroller, "the details scroll inside themselves").not.toBeNull();
  expect(header!.top).toBeGreaterThanOrEqual(content.top - 1);
  expect(header!.bottom).toBeLessThanOrEqual(scroller!.top + 1);
  expect(target!.expanded, "the selected span is expanded").toBe(true);
  expect(target!.top).toBeGreaterThanOrEqual(scroller!.top - 1);
  expect(
    target!.top,
    "the selected span is in the details' visible area",
  ).toBeLessThan(scroller!.bottom - 20);
  return measured;
}

test.describe("desktop", { tag: "@desktop" }, () => {
  test.use({ reducedMotion: "reduce" });

  for (const viewport of viewports)
    test(`on a ${viewport.name} desktop the details scroll inside themselves and show the selected span, without moving the list`, async ({
      page,
    }) => {
      await page.setViewportSize(viewport);
      await longWorkspace(page);
      await page.goto("/telemetry");
      await expect(row(page, 12)).toBeVisible();
      await scrollListTo(page, 12);
      const chosen = { index: 12, top: await rowTop(page, 12) };
      await row(page, 12).click();
      await page.screenshot({
        path: `${evidence}${viewport.name}-selected.png`,
      });
      const opened = await expectContainedAndRevealed(
        page,
        chosen,
        `Provider request ${depth - 4}`,
      );
      // Nothing reflows from here on, so the page must not scroll at all.
      const scrollTop = opened.content.scrollTop;
      await expect(
        page.getByRole("heading", {
          level: 2,
          name: /Model request failed 12/,
        }),
      ).toBeFocused();

      // Scrolling the details to either end, with the wheel, never scrolls the page behind them.
      const panel = page.locator("#telemetry-detail");
      const box = (await panel.boundingBox())!;
      await page.mouse.move(box.x + box.width / 2, box.y + box.height - 40);
      for (const [direction, atEnd] of [
        [
          -1,
          (scroller: NonNullable<Geometry["scroller"]>) =>
            scroller.scrollTop <= 0,
        ],
        [
          1,
          (scroller: NonNullable<Geometry["scroller"]>) =>
            scroller.scrollTop >= scroller.maxScrollTop - 1,
        ],
      ] as const) {
        for (let turn = 0; turn < 40; turn++)
          await page.mouse.wheel(0, direction * 400);
        await expect
          .poll(async () => atEnd((await geometry(page)).scroller!))
          .toBe(true);
        const scrolled = await geometry(page);
        expect(scrolled.content.scrollTop, "the page stayed put").toBe(
          scrollTop,
        );
        expect(scrolled.panel!.bottom).toBeLessThanOrEqual(
          scrolled.content.bottom + 1,
        );
      }
      expect(opened.scroller!.maxScrollTop).toBeGreaterThan(0);
      await page.screenshot({
        path: `${evidence}${viewport.name}-scrolled-to-end.png`,
      });

      // Another record in the same trace reveals its own span, still without moving the page.
      const next = { index: 11, top: await rowTop(page, 11) };
      await row(page, 11).click();
      const reselected = await expectContainedAndRevealed(
        page,
        next,
        `Provider request ${depth - 3}`,
      );
      expect(reselected.content.scrollTop).toBe(scrollTop);
      await page.screenshot({
        path: `${evidence}${viewport.name}-same-trace-reselected.png`,
      });
    });

  test("a trace that arrives after the details open is revealed when it arrives", async ({
    page,
  }) => {
    const workspace = await longWorkspace(page);
    let release!: () => void;
    workspace.traceGate = new Promise((resolve) => {
      release = resolve;
    });
    await page.goto("/telemetry");
    await expect(row(page, 6)).toBeVisible();
    await scrollListTo(page, 6);
    const chosen = { index: 6, top: await rowTop(page, 6) };
    await row(page, 6).click();
    await expect(
      page.getByRole("complementary").getByText("Loading trace…"),
    ).toBeVisible();
    release();
    await expectContainedAndRevealed(
      page,
      chosen,
      `Provider request ${depth - 6}`,
    );
  });

  test("details scrolled by hand stay where they are when the trace refreshes", async ({
    page,
  }) => {
    const workspace = await longWorkspace(page);
    await page.goto("/telemetry");
    await expect(row(page, 0)).toBeVisible();
    const chosen = { index: 0, top: await rowTop(page, 0) };
    await row(page, 0).click();
    const opened = await expectContainedAndRevealed(
      page,
      chosen,
      `Provider request ${depth}`,
    );
    await page.evaluate(() => {
      const scroller = [
        ...document.querySelectorAll("#telemetry-detail, #telemetry-detail *"),
      ].find((element) => element.scrollHeight > element.clientHeight + 1)!;
      scroller.scrollTop = 0;
    });
    const traceRequests = () =>
      workspace.requests.filter((url) =>
        url.pathname.startsWith("/v1/telemetry/traces/"),
      ).length;
    const before = traceRequests();
    await page.getByRole("button", { name: "Refresh" }).click();
    await expect.poll(traceRequests).toBeGreaterThan(before);
    await expect(page.locator(".telemetry-row-button").first()).toBeVisible();
    // Let the refreshed trace render, then check nothing scrolled the details back.
    await page.waitForTimeout(300);
    const { scroller, content } = await geometry(page);
    expect(scroller!.scrollTop).toBe(0);
    expect(content.scrollTop).toBe(opened.content.scrollTop);
  });

  test("opening a record from the keyboard focuses its details without moving the list", async ({
    page,
  }) => {
    await longWorkspace(page);
    await page.goto("/telemetry");
    await expect(row(page, 20)).toBeVisible();
    await row(page, 20).focus();
    const chosen = { index: 20, top: await rowTop(page, 20) };
    await page.keyboard.press("Enter");
    await expectContainedAndRevealed(
      page,
      chosen,
      `Provider request ${depth - 4}`,
    );
    await expect(
      page.getByRole("heading", { level: 2, name: /Model request failed 20/ }),
    ).toBeFocused();
  });
});
