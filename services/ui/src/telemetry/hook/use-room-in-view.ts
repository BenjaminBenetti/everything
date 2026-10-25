import { useLayoutEffect, type RefObject } from "react";
import {
  fitToVisibleArea,
  scrollingAncestor,
  visibleRoom,
} from "./use-visible-height.js";

/**
 * Least height a panel is given in view when it opens, if the window has it: room for its header
 * and several rows of its own contents, enough to read them and scroll through them.
 */
const leastHeight = 300;

/**
 * Give a panel that sticks to the top of its scrolling area room in view when it appears after a
 * change to `dependency`, and while the window resizes with it shown. When less of the area is
 * left below it than its least height, or its whole height if that is less, as at the top of the
 * page on a short window, the area scrolls the least that gives it that room, which never takes
 * the panel past the area's top. A panel docked to the bottom of the view is left alone. Use it
 * after any other hook that scrolls the same area for the same change, since it measures the
 * result.
 */
export function useRoomInView(
  element: RefObject<HTMLElement | null>,
  dependency: unknown,
): void {
  useLayoutEffect(() => {
    const makeRoom = () => {
      const panel = element.current;
      const area = panel && scrollingAncestor(panel);
      // A panel docked to the bottom has no top inset, and fits wherever the area is scrolled.
      if (!panel || !area || getComputedStyle(panel).top === "auto") return;
      const lacking =
        Math.min(leastHeight, fullHeight(panel)) - visibleRoom(panel, area);
      const above =
        panel.getBoundingClientRect().top - area.getBoundingClientRect().top;
      if (lacking <= 0 || above <= 0) return;
      area.scrollTop += Math.ceil(Math.min(lacking, above));
      // Fitted at once, rather than on the next frame, so it never shows at its old height.
      fitToVisibleArea(panel, area);
    };
    makeRoom();
    if (!element.current) return;
    window.addEventListener("resize", makeRoom);
    return () => window.removeEventListener("resize", makeRoom);
  }, [element, dependency]);
}

/** How tall `element` would be if none of its children were cut short to fit it. */
function fullHeight(element: HTMLElement): number {
  let height = element.offsetHeight;
  for (const child of element.children)
    height += child.scrollHeight - child.clientHeight;
  return height;
}
