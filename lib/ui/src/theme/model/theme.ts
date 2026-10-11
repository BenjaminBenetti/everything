/** Every theme implements the same semantic token contract. */
export const themes = [
  { id: "midnight", label: "Midnight", description: "Charcoal & warm amber" },
  {
    id: "midnight-dimmed",
    label: "Midnight Dimmed",
    description: "A softer evening glow",
  },
  {
    id: "graphite",
    label: "Graphite",
    description: "Cool tones & quiet greens",
  },
  {
    id: "graphite-dimmed",
    label: "Graphite Dimmed",
    description: "Low light, gentle contrast",
  },
  {
    id: "daylight",
    label: "Daylight",
    description: "Bright & beautifully clear",
  },
  { id: "sand", label: "Sand", description: "Warm paper & earthy tones" },
] as const;
export type Theme = (typeof themes)[number]["id"];

/** Validate stored values and URL hints before they reach the DOM. */
export function isTheme(value: unknown): value is Theme {
  return themes.some((theme) => theme.id === value);
}
