import assert from "node:assert/strict";
import { test } from "node:test";
import { themes } from "../model/theme.js";
import {
  contrast,
  luminance,
  ownDeclarations,
  readTokenRules,
  resolveTheme,
} from "./token-stylesheet.js";

const rules = readTokenRules();

/** The palette Midnight defines; a theme that skips one would show Midnight's color instead. */
const paletteTokens = [...ownDeclarations(rules, "midnight").keys()];

/** Text needs WCAG AA 4.5:1. Focus borders, status dots, and display-size hero accents need 3:1. */
const readablePairs: [string, string[], number][] = [
  [
    "--text-primary",
    [
      "--surface-page",
      "--surface-panel",
      "--surface-subtle",
      "--surface-review",
      "--surface-selected",
    ],
    4.5,
  ],
  [
    "--text-secondary",
    [
      "--surface-page",
      "--surface-panel",
      "--surface-subtle",
      "--surface-selected",
    ],
    4.5,
  ],
  ["--text-placeholder", ["--surface-panel"], 4.5],
  [
    "--text-accent",
    [
      "--surface-page",
      "--surface-panel",
      "--surface-subtle",
      "--surface-selected",
    ],
    4.5,
  ],
  ["--text-selected", ["--surface-selected"], 4.5],
  ["--text-on-action", ["--surface-action", "--surface-action-hover"], 4.5],
  ["--text-on-hero", ["--surface-hero"], 4.5],
  ["--text-hero-muted", ["--surface-hero"], 4.5],
  ["--text-hero-accent", ["--surface-hero"], 3],
  ["--status-connected", ["--surface-page", "--surface-panel"], 4.5],
  ["--status-disconnected", ["--surface-page", "--surface-panel"], 4.5],
  ["--text-danger", ["--surface-page", "--surface-danger-subtle"], 4.5],
  ["--text-on-danger", ["--surface-danger", "--surface-danger-hover"], 4.5],
  ["--border-active", ["--surface-panel"], 3],
  ["--status-ready", ["--surface-panel"], 3],
];

/** The sixteen canonical Solarized colors. */
const solarizedPalette = new Set([
  "#002b36",
  "#073642",
  "#586e75",
  "#657b83",
  "#839496",
  "#93a1a1",
  "#eee8d5",
  "#fdf6e3",
  "#b58900",
  "#cb4b16",
  "#dc322f",
  "#d33682",
  "#6c71c4",
  "#268bd2",
  "#2aa198",
  "#859900",
]);

/** Palette values a root receives, for comparison with a theme's own rules. */
function palette(tokens: Map<string, string>): Record<string, string> {
  return Object.fromEntries(
    paletteTokens.map((token) => [token, tokens.get(token) ?? "(missing)"]),
  );
}

test("every selectable theme sets each palette token itself, so its preview matches the page", () => {
  assert.ok(paletteTokens.length > 20);
  for (const { id } of themes) {
    const own = ownDeclarations(rules, id);
    assert.deepEqual(
      paletteTokens.filter((token) => !own.has(token)),
      [],
      `${id} is missing palette tokens`,
    );
    assert.deepEqual(palette(resolveTheme(rules, id)), palette(own), id);
  }
});

test("every theme's color scheme matches the brightness of its page", () => {
  for (const { id } of themes) {
    const tokens = resolveTheme(rules, id);
    const page = luminance(tokens.get("--surface-page")!);
    assert.equal(tokens.get("color-scheme"), page > 0.5 ? "light" : "dark", id);
  }
});

test("the page shows Midnight before a theme is applied", () => {
  assert.deepEqual(
    palette(resolveTheme(rules, null)),
    palette(ownDeclarations(rules, "midnight")),
  );
});

test("every theme keeps text, focus, and status colors readable on their surfaces", () => {
  for (const { id } of themes) {
    const tokens = resolveTheme(rules, id);
    for (const [foreground, backgrounds, minimum] of readablePairs)
      for (const background of backgrounds) {
        const ratio = contrast(
          tokens.get(foreground)!,
          tokens.get(background)!,
        );
        assert.ok(
          ratio >= minimum,
          `${id}: ${foreground} on ${background} is ${ratio.toFixed(2)}:1`,
        );
      }
  }
});

test("Solarized themes take surfaces, borders, and hero colors from the canonical palette", () => {
  const anchors = [
    "--surface-page",
    "--surface-review",
    "--surface-hero",
    "--text-primary",
    "--text-on-hero",
    "--text-hero-accent",
    "--border-field",
    "--border-active",
  ];
  for (const id of ["solarized-light", "solarized-dark"]) {
    const tokens = resolveTheme(rules, id);
    for (const token of anchors)
      assert.ok(
        solarizedPalette.has(tokens.get(token)!),
        `${id}: ${token} is ${tokens.get(token)}`,
      );
  }
});

test("light themes show the black ChatGPT mark and dark themes the white one", () => {
  for (const { id } of themes) {
    const tokens = resolveTheme(rules, id);
    const mark = tokens.get("color-scheme") === "light" ? "black" : "white";
    assert.equal(
      tokens.get("--brand-chatgpt-logo"),
      `url("/brand/chatgpt-logo-${mark}.svg")`,
      id,
    );
  }
});
