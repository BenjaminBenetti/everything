import { useLayoutEffect, type RefObject } from "react";

/** Space kept below the element when it reaches the bottom of its scrolling area. */
const bottomGap = 16;

/** Least height given: room for the header and a few rows on a very short window. */
const minimumHeight = 180;

/**
 * Keep the `--visible-height` property of `element` equal to the distance from its top, or from
 * the top of its scrolling area once it reaches it, to the bottom of that area, as the area
 * scrolls, resizes, or its contents move. A sticky panel no taller than this always fits the
 * visible part of the page, so its own contents scroll rather than the page.
 */
export function useVisibleHeight(element: RefObject<HTMLElement | null>): void {
  useLayoutEffect(() => {
    const target = element.current;
    if (!target) return;
    const area = scrollingAncestor(target);
    let frame = 0;
    const measure = () => {
      frame = 0;
      const bounds = area
        ? area.getBoundingClientRect()
        : { top: 0, bottom: window.innerHeight };
      const top = Math.max(target.getBoundingClientRect().top, bounds.top);
      const height = Math.floor(bounds.bottom - top - bottomGap);
      target.style.setProperty(
        "--visible-height",
        `${Math.max(minimumHeight, height)}px`,
      );
    };
    const schedule = () => {
      if (!frame) frame = requestAnimationFrame(measure);
    };
    measure();
    const scroller = area ?? window;
    scroller.addEventListener("scroll", schedule, { passive: true });
    window.addEventListener("resize", schedule);
    // The area's own size, and the page within it, whose changes above the element move it.
    const observer = new ResizeObserver(schedule);
    if (area) {
      observer.observe(area);
      if (area.firstElementChild) observer.observe(area.firstElementChild);
    }
    return () => {
      cancelAnimationFrame(frame);
      scroller.removeEventListener("scroll", schedule);
      window.removeEventListener("resize", schedule);
      observer.disconnect();
    };
  }, [element]);
}

/** The nearest ancestor that scrolls vertically, or none when the document itself does. */
export function scrollingAncestor(element: HTMLElement): HTMLElement | null {
  for (
    let parent = element.parentElement;
    parent;
    parent = parent.parentElement
  ) {
    const { overflowY } = getComputedStyle(parent);
    if (overflowY === "auto" || overflowY === "scroll") return parent;
  }
  return null;
}
