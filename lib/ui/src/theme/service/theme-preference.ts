import { isTheme, type Theme } from "../model/theme.js";

const storageKey = "everything-theme";
const changeEvent = "everything-theme-change";
const defaultTheme: Theme = "midnight";

/** Read the current validated preference from the root, independently of any picker. */
export function currentTheme(): Theme {
  const theme = document.documentElement.dataset.theme;
  return isTheme(theme) ? theme : defaultTheme;
}

/** Update semantic tokens and browser chrome, then notify every mounted consumer. */
function renderTheme(theme: Theme): void {
  document.documentElement.dataset.theme = theme;
  const color = getComputedStyle(document.documentElement)
    .getPropertyValue("--surface-page")
    .trim();
  document
    .querySelector('meta[name="theme-color"]')
    ?.setAttribute("content", color);
  window.dispatchEvent(new Event(changeEvent));
}

/** Save a preference without making browser storage a prerequisite. */
export function applyTheme(theme: Theme): void {
  renderTheme(theme);
  try {
    localStorage.setItem(storageKey, theme);
  } catch {
    /* Storage is optional. */
  }
}

/** Restore the saved appearance before rendering the app; validated URL hints take precedence. */
export function initializeTheme(): void {
  let saved: string | null = null;
  try {
    saved = localStorage.getItem(storageKey);
  } catch {
    /* Fall back to the default. */
  }
  const requested = new URLSearchParams(location.search).get("theme");
  applyTheme(
    isTheme(requested) ? requested : isTheme(saved) ? saved : defaultTheme,
  );
}

/** Synchronize all theme controls and respond to a preference changed in another tab. */
export function subscribeToTheme(listener: () => void): () => void {
  /** Apply only validated theme storage events without writing them back. */
  function restore(event: StorageEvent): void {
    if (event.key === storageKey || event.key === null)
      renderTheme(isTheme(event.newValue) ? event.newValue : defaultTheme);
  }
  window.addEventListener(changeEvent, listener);
  window.addEventListener("storage", restore);
  return () => {
    window.removeEventListener(changeEvent, listener);
    window.removeEventListener("storage", restore);
  };
}
