import { useSyncExternalStore } from "react";

/** The workspace's phone layout, matching the stylesheet's breakpoint. */
const phoneLayout = "(max-width: 650px)";

/** Follow the phone breakpoint's media query. */
function subscribe(onChange: () => void): () => void {
  const query = matchMedia(phoneLayout);
  query.addEventListener("change", onChange);
  return () => query.removeEventListener("change", onChange);
}

/** Whether the workspace shows its desktop layout, with the sidebar, rather than the phone layout. */
export function useDesktopLayout(): boolean {
  return useSyncExternalStore(
    subscribe,
    () => !matchMedia(phoneLayout).matches,
    () => true,
  );
}
