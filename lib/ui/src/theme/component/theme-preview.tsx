import type { Theme } from "../model/theme.js";

/** Preview actual semantic theme tokens in a decorative miniature workspace. */
export function ThemePreview({ theme }: { theme: Theme }) {
  return (
    <span className="theme-preview" data-theme={theme} aria-hidden="true">
      <span className="theme-preview-rail">
        <i />
        <i />
        <i />
        <i />
      </span>
      <span className="theme-preview-content">
        <span className="theme-preview-heading" />
        <span className="theme-preview-hero">
          <i />
          <i />
        </span>
        <span className="theme-preview-cards">
          <i />
          <i />
          <i />
        </span>
      </span>
    </span>
  );
}
