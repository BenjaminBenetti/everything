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

/** The canonical morhetz/gruvbox colors: dark and light tones, gray, and bright, neutral, and faded hues. */
const gruvboxPalette = new Set([
  "#1d2021",
  "#282828",
  "#32302f",
  "#3c3836",
  "#504945",
  "#665c54",
  "#7c6f64",
  "#928374",
  "#f9f5d7",
  "#fbf1c7",
  "#f2e5bc",
  "#ebdbb2",
  "#d5c4a1",
  "#bdae93",
  "#a89984",
  "#fb4934",
  "#b8bb26",
  "#fabd2f",
  "#83a598",
  "#d3869b",
  "#8ec07c",
  "#fe8019",
  "#cc241d",
  "#98971a",
  "#d79921",
  "#458588",
  "#b16286",
  "#689d6a",
  "#d65d0e",
  "#9d0006",
  "#79740e",
  "#b57614",
  "#076678",
  "#8f3f71",
  "#427b58",
  "#af3a03",
]);

/** The page tone, bg0, that morhetz/gruvbox gives each contrast. */
const gruvboxPages = {
  "gruvbox-dark-soft": "#32302f",
  "gruvbox-dark-medium": "#282828",
  "gruvbox-dark-hard": "#1d2021",
  "gruvbox-light-soft": "#f2e5bc",
  "gruvbox-light-medium": "#fbf1c7",
  "gruvbox-light-hard": "#f9f5d7",
};

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

test("Gruvbox variants use their contrast's page tone and take text, borders, actions, and hero colors from the canonical palette", () => {
  const anchors = [
    "--surface-hero",
    "--text-primary",
    "--text-secondary",
    "--text-on-hero",
    "--text-hero-accent",
    "--text-hero-muted",
    "--border-default",
    "--border-field",
    "--border-active",
    "--surface-action",
    "--text-on-action",
    "--status-ready",
    "--surface-danger",
    "--surface-danger-hover",
    "--text-on-danger",
  ];
  for (const [id, page] of Object.entries(gruvboxPages)) {
    const tokens = resolveTheme(rules, id);
    assert.equal(tokens.get("--surface-page"), page, id);
    for (const token of anchors)
      assert.ok(
        gruvboxPalette.has(tokens.get(token)!),
        `${id}: ${token} is ${tokens.get(token)}`,
      );
  }
});

test("harder Gruvbox contrast gives primary text more contrast on the page", () => {
  for (const mode of ["dark", "light"]) {
    const [soft, medium, hard] = ["soft", "medium", "hard"].map((level) => {
      const tokens = resolveTheme(rules, `gruvbox-${mode}-${level}`);
      return contrast(
        tokens.get("--text-primary")!,
        tokens.get("--surface-page")!,
      );
    });
    assert.ok(
      soft! < medium! && medium! < hard!,
      `${mode}: ${[soft, medium, hard].map((ratio) => ratio!.toFixed(2)).join(" < ")}`,
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
