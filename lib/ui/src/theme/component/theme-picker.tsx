import { useId, useSyncExternalStore } from "react";
import { ChoiceCard } from "../../control/component/choice-card.js";
import { themes } from "../model/theme.js";
import {
  applyTheme,
  currentTheme,
  subscribeToTheme,
} from "../service/theme-preference.js";
import { ThemePreview } from "./theme-preview.js";
export { applyTheme, initializeTheme } from "../service/theme-preference.js";

/** Reusable theme selection with previews, immediate application, and radio-keyboard navigation. */
export function ThemePicker() {
  const name = useId();
  const selected = useSyncExternalStore(
    subscribeToTheme,
    currentTheme,
    () => "midnight",
  );
  return (
    <fieldset className="theme-picker" aria-label="Color theme">
      {themes.map((theme) => (
        <ChoiceCard
          key={theme.id}
          name={name}
          value={theme.id}
          label={theme.label}
          description={theme.description}
          checked={theme.id === selected}
          onChange={() => applyTheme(theme.id)}
        >
          <ThemePreview theme={theme.id} />
        </ChoiceCard>
      ))}
    </fieldset>
  );
}
