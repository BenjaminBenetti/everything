import { readFileSync } from "node:fs";

/** One rule of the flat token stylesheet, with declarations in source order. */
export interface TokenRule {
  selectors: string[];
  declarations: Map<string, string>;
}

/** Parse the shipped token stylesheet; it holds only flat `:root` and `[data-theme]` rules. */
export function readTokenRules(): TokenRule[] {
  const css = readFileSync(
    new URL("../style/tokens.css", import.meta.url),
    "utf8",
  ).replace(/\/\*[\s\S]*?\*\//g, "");
  return [...css.matchAll(/([^{}]+)\{([^{}]*)\}/g)].map(([, head, body]) => ({
    selectors: head!.split(",").map((selector) => selector.trim()),
    declarations: new Map(
      body!
        .split(";")
        .map((declaration) => declaration.split(/:(.*)/s))
        .filter(([name, value]) => name?.trim() && value?.trim())
        .map(([name, value]) => [name!.trim(), value!.trim()]),
    ),
  }));
}

/** Declarations from rules that name the theme, which is all a nested preview receives. */
export function ownDeclarations(
  rules: TokenRule[],
  theme: string,
): Map<string, string> {
  return cascade(
    rules.filter((rule) => rule.selectors.includes(`[data-theme="${theme}"]`)),
  );
}

/** Declarations the document root receives with this theme, or with no theme before scripts run. */
export function resolveTheme(
  rules: TokenRule[],
  theme: string | null,
): Map<string, string> {
  return cascade(
    rules.filter(
      (rule) =>
        rule.selectors.includes(":root") ||
        (theme !== null && rule.selectors.includes(`[data-theme="${theme}"]`)),
    ),
  );
}

/** `:root` and `[data-theme]` share specificity, so later rules win. */
function cascade(rules: TokenRule[]): Map<string, string> {
  const declarations = new Map<string, string>();
  for (const rule of rules)
    for (const [name, value] of rule.declarations)
      declarations.set(name, value);
  return declarations;
}

/** WCAG relative luminance of an opaque `#rrggbb` color. */
export function luminance(color: string): number {
  const match = /^#([0-9a-f]{2})([0-9a-f]{2})([0-9a-f]{2})$/i.exec(color);
  if (!match) throw new Error(`Expected an opaque hex color, got ${color}`);
  const [red, green, blue] = match.slice(1).map((channel) => {
    const value = parseInt(channel, 16) / 255;
    return value <= 0.03928 ? value / 12.92 : ((value + 0.055) / 1.055) ** 2.4;
  });
  return 0.2126 * red! + 0.7152 * green! + 0.0722 * blue!;
}

/** WCAG contrast ratio between two opaque colors. */
export function contrast(first: string, second: string): number {
  const [lighter, darker] = [luminance(first), luminance(second)].sort(
    (a, b) => b - a,
  );
  return (lighter! + 0.05) / (darker! + 0.05);
}
