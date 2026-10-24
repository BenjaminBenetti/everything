import { mkdirSync, writeFileSync } from "node:fs";
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

/** Keep named measurements beside the screenshots, as evidence of what the user would see. */
function record(name: string, measured: unknown): void {
  mkdirSync(evidence, { recursive: true });
  writeFileSync(`${evidence}${name}.json`, JSON.stringify(measured, null, 1));
}

/** Least height of the details' own scrolling area for it to be usable: a few rows. */
const usableBody = 96;

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
  readonly close: { top: number; bottom: number } | null;
  /** The panel's own scrolling area, if its content overflows one. */
  readonly scroller: {
    top: number;
    bottom: number;
    height: number;
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
      close: box(panel?.querySelector('button[aria-label="Close details"]')),
      scroller: scroller
        ? {
            ...box(scroller)!,
            height: scroller.clientHeight,
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

/** Where a span, by its title, is on screen. */
function spanTop(page: Page, title: string): Promise<number> {
  return page.evaluate(
    (name) =>
      [...document.querySelectorAll("#telemetry-detail .telemetry-span-name")]
        .find((element) => element.textContent === name)!
        .getBoundingClientRect().top,
    title,
  );
}

/** What the reader is looking at in the details: their scroll offset and the first span in view. */
function readingPosition(
  page: Page,
): Promise<{ scrollTop: number; span: string; top: number }> {
  return page.evaluate(() => {
    const body = document.querySelector<HTMLElement>(".telemetry-detail-body")!;
    const view = body.getBoundingClientRect();
    const first = [
      ...body.querySelectorAll<HTMLElement>(".telemetry-span-name"),
    ].find((element) => element.getBoundingClientRect().top >= view.top)!;
    return {
      scrollTop: body.scrollTop,
      span: first.textContent!,
      top: first.getBoundingClientRect().top,
    };
  });
}

/** How a reader opens a record: with the pointer, or by tabbing to its row and pressing Enter. */
type Opening = "pointer" | "keyboard";

/** Where a record's row was at the top of the page, and how far the page scrolled to reach it. */
interface Reached {
  /** The row's button at the top of the page, before anything scrolled. */
  readonly atPageTop: { top: number; bottom: number; visible: number };
  /** How far the page had scrolled when the record was opened: the least to reach the row. */
  readonly scrolledToReachRow: number;
}

/**
 * Open the record with `index` from the very top of the page, as a reader would. With the
 * pointer, the part of its row in view is clicked without scrolling at all; only when none of it
 * is in view is the page scrolled, the least that brings the row into view, as the reader must to
 * see it. With the keyboard, Tab moves focus through the page to the row, which the browser
 * scrolls into view as it would for anyone tabbing, and Enter opens it.
 */
async function openFromPageTop(
  page: Page,
  index: number,
  opening: Opening,
): Promise<Reached> {
  const title = `Model request failed ${index}`;
  const measure = () =>
    page.evaluate((name) => {
      const content = document.getElementById("workspace-content")!;
      const button = [...document.querySelectorAll(".telemetry-title")]
        .find((element) => element.textContent === name)!
        .closest("button")!;
      const view = content.getBoundingClientRect();
      const box = button.getBoundingClientRect();
      return {
        scrollTop: content.scrollTop,
        top: box.top,
        bottom: box.bottom,
        visible: Math.max(0, Math.min(box.bottom, view.bottom) - box.top),
      };
    }, title);
  const start = await measure();
  expect(start.scrollTop, "the page is at its top").toBe(0);
  const atPageTop = {
    top: start.top,
    bottom: start.bottom,
    visible: start.visible,
  };
  if (opening === "keyboard") {
    // The row's own button, not a scrolling area around it, which Tab also stops at.
    const focused = () =>
      page.evaluate((name) => {
        const active = document.activeElement;
        return (
          !!active?.matches(".telemetry-row-button") &&
          active.querySelector(".telemetry-title")?.textContent === name
        );
      }, title);
    for (let press = 0; press < 80 && !(await focused()); press++)
      await page.keyboard.press("Tab");
    expect(await focused(), "Tab reached the row").toBe(true);
    const reached = await measure();
    await page.keyboard.press("Enter");
    return { atPageTop, scrolledToReachRow: reached.scrollTop };
  }
  const point = await page.evaluate((name) => {
    const content = document.getElementById("workspace-content")!;
    const button = [...document.querySelectorAll(".telemetry-title")]
      .find((element) => element.textContent === name)!
      .closest("button")!;
    const view = content.getBoundingClientRect();
    if (button.getBoundingClientRect().top >= view.bottom - 1)
      content.scrollTop += Math.ceil(
        button.getBoundingClientRect().bottom - view.bottom + 1,
      );
    const box = button.getBoundingClientRect();
    const x = box.left + 24;
    const y = (box.top + Math.min(box.bottom, view.bottom)) / 2;
    return {
      scrollTop: content.scrollTop,
      x,
      y,
      hit: document.elementFromPoint(x, y)?.closest("button") === button,
    };
  }, title);
  expect(point.hit, "the click lands on the row").toBe(true);
  await page.mouse.click(point.x, point.y);
  return { atPageTop, scrolledToReachRow: point.scrollTop };
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

/**
 * The details panel, its header and Close button, a usable scrolling body, the selected span, and
 * the chosen row are all within the content area, without the reader having scrolled the page.
 */
async function expectWholePanelUsable(
  page: Page,
  index: number,
): Promise<void> {
  const { content, panel, header, close, scroller, target, documentScrollTop } =
    await geometry(page);
  expect(documentScrollTop).toBe(0);
  expect(panel!.top, "the panel starts in view").toBeGreaterThanOrEqual(
    content.top - 1,
  );
  expect(panel!.bottom, "the panel ends in view").toBeLessThanOrEqual(
    content.bottom + 1,
  );
  expect(header!.top).toBeGreaterThanOrEqual(content.top - 1);
  expect(close!.top, "Close is in view").toBeGreaterThanOrEqual(
    content.top - 1,
  );
  expect(close!.bottom).toBeLessThanOrEqual(content.bottom + 1);
  expect(scroller, "the details scroll inside themselves").not.toBeNull();
  expect(
    scroller!.height,
    "the scrolling body has room for a few rows",
  ).toBeGreaterThanOrEqual(usableBody);
  expect(scroller!.maxScrollTop).toBeGreaterThan(0);
  expect(target!.expanded, "the selected span is expanded").toBe(true);
  expect(target!.top).toBeGreaterThanOrEqual(scroller!.top - 1);
  expect(target!.top, "the selected span is in view").toBeLessThan(
    scroller!.bottom - 20,
  );
  if (target!.bottom - target!.top <= scroller!.height)
    expect(
      target!.bottom,
      "the whole selected span is in view, as it fits",
    ).toBeLessThanOrEqual(scroller!.bottom + 1);
  const chosen = await rowTop(page, index);
  expect(chosen, "the chosen row is still in view").toBeGreaterThanOrEqual(
    content.top - 1,
  );
  expect(chosen).toBeLessThan(content.bottom - 20);
}

/** The prompt whose provider request arrives after the record's event, in the late-span tests. */
const waitingSpan = 20;

/** A failure recorded in the trace whose provider request span hasn't arrived yet. */
const waitingRecord = {
  ...longRecords(1, () => `3${String(waitingSpan).padStart(15, "0")}`)[0]!,
  id: "00000000-0000-4000-8000-999999999999",
  title: "Model request failed while waiting",
};

/** The full trace, with the waiting record's event and, when it arrives, its span. */
function fullTrace() {
  return { ...longTrace(depth), events: [waitingRecord] as unknown[] };
}

/**
 * The trace before the record's span arrives: its event, but not its span. For the watching case
 * it also lacks its root span, as an unfinished turn's trace does, so the page keeps checking it.
 */
function partialTrace(arrival: "Refresh" | "watching") {
  const trace = fullTrace();
  const waiting = `3${String(waitingSpan).padStart(15, "0")}`;
  return {
    ...trace,
    spans: trace.spans.filter(
      (span) =>
        (span as { id: string }).id !== waiting &&
        (arrival === "Refresh" ||
          (span as { parentSpanId: string | null }).parentSpanId !== null),
    ),
  };
}

/** A workspace listing the waiting record first, with its span not yet in the trace. */
async function partialTraceWorkspace(
  page: Page,
  arrival: "Refresh" | "watching",
): Promise<TelemetryWorkspace> {
  if (arrival === "watching")
    // The page checks an unfinished trace for ten minutes after its record.
    await page.clock.install({ time: new Date("2026-10-23T11:58:20.000Z") });
  const workspace = await telemetryWorkspace(page.context());
  workspace.eventPages.set("", {
    records: [waitingRecord, ...longRecords(39, spanOf)],
    nextCursor: null,
  });
  workspace.trace = partialTrace(arrival);
  workspace.eventDetail = { message: longMessage, textWithheld: false };
  return workspace;
}

/** Open the waiting record; its event stands in for its span, and is revealed. */
async function openWaitingForSpan(page: Page): Promise<void> {
  await page.goto("/telemetry");
  const waiting = page.getByRole("button", {
    name: /Model request failed while waiting/,
  });
  await expect(waiting).toBeVisible();
  await waiting.click();
  const event = page.locator(
    '#telemetry-detail .telemetry-trace-events button[aria-pressed="true"]',
  );
  await expect(event).toHaveCount(1);
  await expect(page.locator(".telemetry-span.highlighted")).toHaveCount(0);
  await expect
    .poll(() =>
      page.evaluate(() => {
        const body = document.querySelector(".telemetry-detail-body")!;
        const item = document.querySelector(
          '#telemetry-detail .telemetry-trace-events button[aria-pressed="true"]',
        )!;
        const view = body.getBoundingClientRect();
        const box = item.getBoundingClientRect();
        return box.top >= view.top - 1 && box.bottom <= view.bottom + 1;
      }),
    )
    .toBe(true);
  await page.screenshot({ path: `${evidence}span-waiting-event-shown.png` });
}

/**
 * A trace still being recorded, which the page keeps watching: `prompts` prompts, the waiting
 * record's span among them, and the waiting record's event, but no root span yet.
 */
function unfinishedTrace(prompts: number) {
  return {
    ...longTrace(prompts),
    spans: longTrace(prompts).spans.filter(
      (span) => (span as { parentSpanId: string | null }).parentSpanId !== null,
    ),
    events: [waitingRecord] as unknown[],
  };
}

/** Let the trace be fetched again: by pressing Refresh, or by the page's own watching. */
async function arrive(
  page: Page,
  arrival: "Refresh" | "watching",
): Promise<void> {
  if (arrival === "Refresh")
    await page.getByRole("button", { name: "Refresh" }).click();
  else await page.clock.fastForward(6_000);
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

  test("details scrolled by hand stay where they are when the trace refreshes with new spans", async ({
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
    // The reader scrolls the details back a little, with the wheel, to read earlier spans.
    const box = (await page.locator("#telemetry-detail").boundingBox())!;
    await page.mouse.move(box.x + box.width / 2, box.y + box.height - 40);
    for (let turn = 0; turn < 3; turn++) await page.mouse.wheel(0, -300);
    await expect
      .poll(async () => (await geometry(page)).scroller!.scrollTop)
      .toBe(opened.scroller!.scrollTop - 900);
    const read = await readingPosition(page);

    // The trace refreshes with a new prompt and provider request after the others.
    workspace.trace = longTrace(depth + 1);
    await page.getByRole("button", { name: "Refresh" }).click();
    await expect(
      page
        .locator("#telemetry-detail .telemetry-span-name")
        .filter({ hasText: `Provider request ${depth + 1}` }),
      "the refreshed trace is shown",
    ).toHaveCount(1);
    const refreshed = await geometry(page);
    expect(refreshed.scroller!.scrollTop, "the details didn't scroll").toBe(
      read.scrollTop,
    );
    expect(
      Math.abs((await spanTop(page, read.span)) - read.top),
      "the span the reader was looking at stayed in place",
    ).toBeLessThan(1);
    expect(refreshed.content.scrollTop, "the page didn't scroll").toBe(
      opened.content.scrollTop,
    );
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

  // ===========================================
  // Short windows, opened at the top of the page
  // ===========================================

  for (const height of [500, 440])
    for (const opening of ["pointer", "keyboard"] as const)
      test(`opening the first record at the top of a ${height} px window, by ${opening}, shows its whole details panel, without scrolling the page by hand`, async ({
        page,
      }) => {
        await page.setViewportSize({ width: 1440, height });
        await longWorkspace(page);
        await page.goto("/telemetry");
        await expect(row(page, 0)).toBeAttached();
        const reached = await openFromPageTop(page, 0, opening);
        await expect
          .poll(async () => (await geometry(page)).target?.title)
          .toBe(`Provider request ${depth}`);
        const opened = await geometry(page);
        const name = `page-top-${height}-${opening}`;
        record(name, { ...reached, ...opened });
        await page.screenshot({ path: `${evidence}${name}-opened.png` });
        await expectWholePanelUsable(page, 0);
        await expect(
          page.getByRole("heading", {
            level: 2,
            name: /Model request failed 0/,
          }),
        ).toBeFocused();

        // Its contents scroll to their end inside it, never moving the page.
        const box = (await page.locator("#telemetry-detail").boundingBox())!;
        await page.mouse.move(box.x + box.width / 2, box.y + box.height - 30);
        for (let turn = 0; turn < 40; turn++) await page.mouse.wheel(0, 400);
        await expect
          .poll(async () => {
            const { scroller } = await geometry(page);
            return scroller!.scrollTop >= scroller!.maxScrollTop - 1;
          })
          .toBe(true);
        const ended = await geometry(page);
        record(`${name}-panel-end`, ended);
        expect(ended.content.scrollTop, "the page stayed put").toBe(
          opened.content.scrollTop,
        );
        await page.screenshot({ path: `${evidence}${name}-panel-end.png` });
        await expect(
          page.getByRole("heading", {
            level: 2,
            name: /Model request failed 0/,
          }),
        ).toBeFocused();
      });

  test("shrinking the window to 500 px with the details open keeps the whole panel usable", async ({
    page,
  }) => {
    await longWorkspace(page);
    await page.goto("/telemetry");
    await expect(row(page, 0)).toBeVisible();
    await row(page, 0).click();
    await expect
      .poll(async () => (await geometry(page)).target?.title)
      .toBe(`Provider request ${depth}`);
    record("resize-960-opened", await geometry(page));
    await page.setViewportSize({ width: 1440, height: 500 });
    await expect
      .poll(async () => {
        const { panel, content } = await geometry(page);
        return panel!.bottom <= content.bottom + 1;
      })
      .toBe(true);
    record("resize-500", await geometry(page));
    await page.screenshot({ path: `${evidence}resize-960-to-500.png` });
    await expectWholePanelUsable(page, 0);
  });

  // ===========================================
  // A record's span arriving after its event
  // ===========================================

  for (const arrival of ["Refresh", "watching"] as const)
    test(`a span that arrives after its event is revealed in the event's place, by ${arrival}, when the reader hasn't scrolled`, async ({
      page,
    }) => {
      const workspace = await partialTraceWorkspace(page, arrival);
      await openWaitingForSpan(page);
      workspace.trace = fullTrace();
      await arrive(page, arrival);
      await expect
        .poll(async () => (await geometry(page)).target?.title)
        .toBe(`Provider request ${waitingSpan}`);
      const arrived = await geometry(page);
      record(`span-arrives-${arrival}`, arrived);
      await page.screenshot({
        path: `${evidence}span-arrives-${arrival}.png`,
      });
      expect(arrived.target!.expanded).toBe(true);
      expect(arrived.target!.top).toBeGreaterThanOrEqual(
        arrived.scroller!.top - 1,
      );
      expect(
        arrived.target!.top,
        "the arriving span is in the details' visible area",
      ).toBeLessThan(arrived.scroller!.bottom - 20);
    });

  test("watching a trace that keeps changing never moves the details again once its span is revealed", async ({
    page,
  }) => {
    const workspace = await partialTraceWorkspace(page, "watching");
    await openWaitingForSpan(page);
    workspace.trace = unfinishedTrace(depth);
    await arrive(page, "watching");
    await expect
      .poll(async () => (await geometry(page)).target?.title)
      .toBe(`Provider request ${waitingSpan}`);
    const revealed = await geometry(page);

    // The next check finds more of the trace; the reader hasn't scrolled, and nothing moves.
    workspace.trace = unfinishedTrace(depth + 1);
    await arrive(page, "watching");
    await expect(
      page
        .locator("#telemetry-detail .telemetry-span-name")
        .filter({ hasText: `Provider request ${depth + 1}` }),
      "the trace was checked again and grew",
    ).toHaveCount(1);
    const grown = await geometry(page);
    record("watching-grows-after-reveal", grown);
    expect(grown.scroller!.scrollTop, "the details didn't scroll").toBe(
      revealed.scroller!.scrollTop,
    );
    expect(grown.target!.top, "the span stayed in place").toBe(
      revealed.target!.top,
    );
    expect(grown.content.scrollTop, "the page didn't scroll").toBe(
      revealed.content.scrollTop,
    );

    // The reader scrolls back a little; the check after that doesn't move them either.
    const box = (await page.locator("#telemetry-detail").boundingBox())!;
    await page.mouse.move(box.x + box.width / 2, box.y + box.height - 40);
    await page.mouse.wheel(0, -300);
    await expect
      .poll(async () => (await geometry(page)).scroller!.scrollTop)
      .toBe(revealed.scroller!.scrollTop - 300);
    const read = await readingPosition(page);
    workspace.trace = unfinishedTrace(depth + 2);
    await arrive(page, "watching");
    await expect(
      page
        .locator("#telemetry-detail .telemetry-span-name")
        .filter({ hasText: `Provider request ${depth + 2}` }),
      "the trace was checked again and grew",
    ).toHaveCount(1);
    const regrown = await geometry(page);
    expect(regrown.scroller!.scrollTop, "the details didn't scroll").toBe(
      read.scrollTop,
    );
    expect(
      Math.abs((await spanTop(page, read.span)) - read.top),
      "the span the reader was looking at stayed in place",
    ).toBeLessThan(1);
    expect(regrown.content.scrollTop, "the page didn't scroll").toBe(
      revealed.content.scrollTop,
    );
  });

  test("a span that arrives after the reader scrolled away from its event leaves them where they are", async ({
    page,
  }) => {
    const workspace = await partialTraceWorkspace(page, "Refresh");
    await openWaitingForSpan(page);
    // The reader scrolls back to the top of the details.
    const box = (await page.locator("#telemetry-detail").boundingBox())!;
    await page.mouse.move(box.x + box.width / 2, box.y + box.height - 40);
    for (let turn = 0; turn < 40; turn++) await page.mouse.wheel(0, -400);
    await expect
      .poll(async () => (await geometry(page)).scroller!.scrollTop)
      .toBe(0);
    const read = await readingPosition(page);
    workspace.trace = fullTrace();
    await arrive(page, "Refresh");
    await expect
      .poll(async () => (await geometry(page)).target?.title)
      .toBe(`Provider request ${waitingSpan}`);
    const arrived = await geometry(page);
    record("span-arrives-after-reader-scrolled", arrived);
    expect(arrived.target!.expanded, "the span still opens").toBe(true);
    expect(arrived.scroller!.scrollTop, "the details didn't scroll").toBe(
      read.scrollTop,
    );
    expect(
      Math.abs((await spanTop(page, read.span)) - read.top),
      "what the reader was looking at stayed in place",
    ).toBeLessThan(1);
  });
});
