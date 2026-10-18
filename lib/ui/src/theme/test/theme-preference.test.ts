import assert from "node:assert/strict";
import { test } from "node:test";
import { isTheme, themes } from "../model/theme.js";
import {
  applyTheme,
  currentTheme,
  initializeTheme,
  subscribeToTheme,
} from "../service/theme-preference.js";
import { readTokenRules, resolveTheme } from "./token-stylesheet.js";

const storageKey = "everything-theme";
const rules = readTokenRules();

/** Themes people could have saved before Solarized was added. */
const earlierThemes = [
  "midnight",
  "midnight-dimmed",
  "graphite",
  "graphite-dimmed",
  "daylight",
  "sand",
];

/** The classic Gruvbox variants, dark then light, each from soft to hard contrast. */
const gruvboxThemes = [
  "gruvbox-dark-soft",
  "gruvbox-dark-medium",
  "gruvbox-dark-hard",
  "gruvbox-light-soft",
  "gruvbox-light-medium",
  "gruvbox-light-hard",
] as const;

/** The page color the shipped stylesheet gives a root with this theme. */
function pageColor(theme: string): string {
  return resolveTheme(rules, theme).get("--surface-page")!;
}

/**
 * Install the browser surface the preference service touches: the root element, the
 * theme-color meta tag, computed styles from the real token stylesheet, storage, and the URL.
 */
function installBrowser({
  saved,
  search = "",
  blockedStorage = false,
}: {
  saved?: string;
  search?: string;
  blockedStorage?: boolean;
} = {}) {
  const root = { dataset: {} as Record<string, string | undefined> };
  const meta = { content: "" };
  const values = new Map<string, string>();
  if (saved !== undefined) values.set(storageKey, saved);
  const writes: string[] = [];
  const blocked = () => {
    throw new Error("Storage is blocked");
  };
  const globals = {
    document: {
      documentElement: root,
      querySelector: (selector: string) =>
        selector === 'meta[name="theme-color"]'
          ? {
              setAttribute: (name: string, value: string) => {
                if (name === "content") meta.content = value;
              },
            }
          : null,
    },
    getComputedStyle: (element: typeof root) => ({
      getPropertyValue: (name: string) =>
        ` ${resolveTheme(rules, element.dataset.theme ?? null).get(name) ?? ""} `,
    }),
    window: new EventTarget(),
    localStorage: blockedStorage
      ? { getItem: blocked, setItem: blocked }
      : {
          getItem: (key: string) => values.get(key) ?? null,
          setItem: (key: string, value: string) => {
            writes.push(value);
            values.set(key, value);
          },
        },
    location: { search },
  };
  for (const [name, value] of Object.entries(globals))
    Object.defineProperty(globalThis, name, {
      value,
      configurable: true,
      writable: true,
    });
  return {
    root,
    meta,
    writes,
    saved: () => values.get(storageKey),
    /** Deliver the event another tab's storage write produces. */
    otherTab(key: string | null, newValue: string | null) {
      if (key !== null && newValue !== null) values.set(key, newValue);
      globals.window.dispatchEvent(
        Object.assign(new Event("storage"), { key, newValue }),
      );
    },
  };
}

test("lists Solarized, then the six Gruvbox variants, after the earlier themes, which keep their order", () => {
  assert.deepEqual(
    themes.map((theme) => theme.id),
    [...earlierThemes, "solarized-light", "solarized-dark", ...gruvboxThemes],
  );
  assert.deepEqual(
    themes.slice(-8).map((theme) => theme.label),
    [
      "Solarized Light",
      "Solarized Dark",
      "Gruvbox Dark Soft",
      "Gruvbox Dark Medium",
      "Gruvbox Dark Hard",
      "Gruvbox Light Soft",
      "Gruvbox Light Medium",
      "Gruvbox Light Hard",
    ],
  );
  for (const value of [
    "solarized",
    "Solarized-Dark",
    "solarized_light",
    "gruvbox",
    "gruvbox-dark",
    "Gruvbox-Light-Hard",
    "gruvbox_dark_medium",
    "",
  ])
    assert.equal(isTheme(value), false, value);
});

test("restores every saved theme, including choices saved before Solarized and Gruvbox existed", () => {
  for (const { id } of themes) {
    const browser = installBrowser({ saved: id });
    initializeTheme();
    assert.equal(currentTheme(), id);
    assert.equal(browser.root.dataset.theme, id);
    assert.equal(browser.saved(), id);
    assert.equal(browser.meta.content, pageColor(id));
  }
});

test("starts new devices on Midnight and replaces unknown saved values with it", () => {
  for (const saved of [
    undefined,
    "solarized",
    "Solarized-Light",
    "gruvbox",
    "gruvbox-medium",
  ]) {
    const browser = installBrowser(saved === undefined ? {} : { saved });
    initializeTheme();
    assert.equal(currentTheme(), "midnight");
    assert.equal(browser.saved(), "midnight");
    assert.equal(browser.meta.content, pageColor("midnight"));
  }
});

test("a valid theme link wins over the saved choice and is remembered; others are ignored", () => {
  const linked = installBrowser({
    saved: "sand",
    search: "?theme=solarized-dark",
  });
  initializeTheme();
  assert.equal(linked.root.dataset.theme, "solarized-dark");
  assert.equal(linked.saved(), "solarized-dark");

  const ignored = installBrowser({
    saved: "solarized-light",
    search: "?theme=solarized",
  });
  initializeTheme();
  assert.equal(ignored.root.dataset.theme, "solarized-light");

  const gruvbox = installBrowser({
    saved: "midnight",
    search: "?theme=gruvbox-light-hard",
  });
  initializeTheme();
  assert.equal(gruvbox.root.dataset.theme, "gruvbox-light-hard");
  assert.equal(gruvbox.saved(), "gruvbox-light-hard");

  const unknown = installBrowser({
    saved: "gruvbox-dark-soft",
    search: "?theme=gruvbox-dark",
  });
  initializeTheme();
  assert.equal(unknown.root.dataset.theme, "gruvbox-dark-soft");
});

test("choosing a Solarized theme saves it, recolors browser chrome, and updates every picker", () => {
  const browser = installBrowser({ saved: "midnight" });
  initializeTheme();
  let changes = 0;
  const unsubscribe = subscribeToTheme(() => changes++);

  applyTheme("solarized-light");
  assert.equal(currentTheme(), "solarized-light");
  assert.equal(browser.saved(), "solarized-light");
  assert.equal(browser.meta.content, pageColor("solarized-light"));
  applyTheme("solarized-dark");
  assert.equal(browser.meta.content, pageColor("solarized-dark"));
  assert.notEqual(pageColor("solarized-light"), pageColor("solarized-dark"));
  assert.equal(changes, 2);

  unsubscribe();
  applyTheme("graphite");
  assert.equal(changes, 2);
});

test("choosing each Gruvbox variant saves it and recolors browser chrome with its own page", () => {
  const browser = installBrowser({ saved: "midnight" });
  initializeTheme();
  let changes = 0;
  const unsubscribe = subscribeToTheme(() => changes++);

  for (const id of gruvboxThemes) {
    applyTheme(id);
    assert.equal(currentTheme(), id);
    assert.equal(browser.saved(), id);
    assert.equal(browser.meta.content, pageColor(id));
  }
  assert.equal(new Set(gruvboxThemes.map(pageColor)).size, 6);
  assert.equal(changes, gruvboxThemes.length);
  unsubscribe();
});

test("follows a choice made in another tab without saving it again", () => {
  const browser = installBrowser({ saved: "daylight" });
  initializeTheme();
  const writesBefore = browser.writes.length;
  let changes = 0;
  const unsubscribe = subscribeToTheme(() => changes++);

  browser.otherTab(storageKey, "solarized-dark");
  assert.equal(currentTheme(), "solarized-dark");
  assert.equal(browser.meta.content, pageColor("solarized-dark"));
  browser.otherTab("unrelated", "solarized-light");
  assert.equal(currentTheme(), "solarized-dark");
  browser.otherTab(null, null);
  assert.equal(currentTheme(), "midnight");
  browser.otherTab(storageKey, "solarized-light");
  assert.equal(currentTheme(), "solarized-light");
  browser.otherTab(storageKey, "solarized");
  assert.equal(currentTheme(), "midnight");
  browser.otherTab(storageKey, "gruvbox-dark-hard");
  assert.equal(currentTheme(), "gruvbox-dark-hard");
  assert.equal(browser.meta.content, pageColor("gruvbox-dark-hard"));
  browser.otherTab(storageKey, "gruvbox");
  assert.equal(currentTheme(), "midnight");

  assert.equal(changes, 6);
  assert.equal(browser.writes.length, writesBefore);
  unsubscribe();
});

test("applies themes when browser storage is blocked", () => {
  const browser = installBrowser({
    blockedStorage: true,
    search: "?theme=solarized-light",
  });
  initializeTheme();
  assert.equal(browser.root.dataset.theme, "solarized-light");
  applyTheme("solarized-dark");
  assert.equal(currentTheme(), "solarized-dark");
});
