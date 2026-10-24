import { useCallback, useLayoutEffect, useRef } from "react";
import { scrollingAncestor } from "./use-visible-height.js";

/**
 * Keep an element where it is on screen across the render that follows a change to `dependency`,
 * by scrolling its scrolling area as far as the render moved it, as when opening the details
 * narrows the list the element is in. Call the returned function with the element just before
 * making the change.
 */
export function useKeepInPlace(
  dependency: unknown,
): (element: HTMLElement | null) => void {
  const kept = useRef<{ element: HTMLElement; top: number } | null>(null);
  useLayoutEffect(() => {
    const target = kept.current;
    kept.current = null;
    if (!target?.element.isConnected) return;
    const area = scrollingAncestor(target.element);
    const moved = target.element.getBoundingClientRect().top - target.top;
    if (area && Math.abs(moved) >= 0.5) area.scrollTop += moved;
  }, [dependency]);
  return useCallback((element: HTMLElement | null) => {
    kept.current = element
      ? { element, top: element.getBoundingClientRect().top }
      : null;
  }, []);
}
