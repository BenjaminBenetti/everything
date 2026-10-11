/** Every theme implements the same semantic token contract. */
export const themes = [
  { id: "midnight", label: "Midnight", description: "Charcoal & warm amber" },
  {
    id: "midnight-dimmed",
    label: "Midnight Dimmed",
    description: "Charcoal & muted amber",
  },
  {
    id: "graphite",
    label: "Graphite",
    description: "Cool gray & green",
  },
  {
    id: "graphite-dimmed",
    label: "Graphite Dimmed",
    description: "Cool gray & muted green",
  },
  {
    id: "daylight",
    label: "Daylight",
    description: "White & blue",
  },
  { id: "sand", label: "Sand", description: "Warm neutrals & brown" },
] as const;
export type Theme = (typeof themes)[number]["id"];

/** Validate stored values and URL hints before they reach the DOM. */
export function isTheme(value: unknown): value is Theme {
  return themes.some((theme) => theme.id === value);
}
