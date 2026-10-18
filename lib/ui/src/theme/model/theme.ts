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
  {
    id: "solarized-light",
    label: "Solarized Light",
    description: "Cream & blue",
  },
  {
    id: "solarized-dark",
    label: "Solarized Dark",
    description: "Deep teal & blue",
  },
  {
    id: "gruvbox-dark-soft",
    label: "Gruvbox Dark Soft",
    description: "Lower contrast, warm gray & orange",
  },
  {
    id: "gruvbox-dark-medium",
    label: "Gruvbox Dark Medium",
    description: "Default contrast, warm gray & orange",
  },
  {
    id: "gruvbox-dark-hard",
    label: "Gruvbox Dark Hard",
    description: "Higher contrast, warm gray & orange",
  },
  {
    id: "gruvbox-light-soft",
    label: "Gruvbox Light Soft",
    description: "Lower contrast, warm cream & orange",
  },
  {
    id: "gruvbox-light-medium",
    label: "Gruvbox Light Medium",
    description: "Default contrast, warm cream & orange",
  },
  {
    id: "gruvbox-light-hard",
    label: "Gruvbox Light Hard",
    description: "Higher contrast, warm cream & orange",
  },
] as const;
export type Theme = (typeof themes)[number]["id"];

/** Validate stored values and URL hints before they reach the DOM. */
export function isTheme(value: unknown): value is Theme {
  return themes.some((theme) => theme.id === value);
}
