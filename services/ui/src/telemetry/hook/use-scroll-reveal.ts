import {
  useCallback,
  useEffect,
  useLayoutEffect,
  useRef,
  useState,
  type RefObject,
} from "react";

/** Most room left above a revealed target, so what leads to it stays in sight. */
const contextAbove = 96;

/**
 * Input by which a reader moves through the area themselves: a wheel or touch scrolling it, a
 * press on it or its scrollbar, or focus moving into it or keys pressed in it. The browser also
 * scrolls the area by itself, keeping its offset in range as it grows or keeping what is in view
 * in place as content above it changes, so scrolling alone doesn't show the reader moved it.
 */
const readerInput = [
  "wheel",
  "touchstart",
  "pointerdown",
  "focusin",
  "keydown",
] as const;

/** A scrolling area and the target it should bring into view. */
export interface ScrollReveal<Area extends HTMLElement> {
  /** The scrolling area; only it is scrolled, never the page around it. */
  readonly area: RefObject<Area | null>;
  /** A callback ref for the target, which may appear after the area, as data arrives. */
  readonly target: (element: HTMLElement | null) => void;
  /** A callback ref for what stands in for the target until the target appears, if anything. */
  readonly fallback: (element: HTMLElement | null) => void;
}

/**
 * Bring a target into its scrolling area's view when it first appears and `ready` is true, with a
 * little room above it, or its fallback while the target hasn't appeared. A target that appears
 * after its fallback was revealed is revealed in its turn, and what was revealed stays in view as
 * the window resizes. Only the area is scrolled, without animation, so the page around it never
 * moves. Nothing else is scrolled, so data refreshing in place never moves what the reader is
 * looking at, and once the reader moves through the area themselves, nothing more is revealed.
 * The browser adjusting the area's offset by itself, as it resizes or as content above what is in
 * view changes, isn't the reader's doing, and doesn't stop a reveal.
 */
export function useScrollReveal<Area extends HTMLElement>(
  ready: boolean,
): ScrollReveal<Area> {
  const area = useRef<Area>(null);
  const [target, setTarget] = useState<HTMLElement | null>(null);
  const [fallback, setFallback] = useState<HTMLElement | null>(null);
  // Revealing the target is final; revealing its fallback waits for the target.
  const revealed = useRef<"target" | "fallback" | null>(null);
  const readerMoved = useRef(false);

  useEffect(() => {
    const scroller = area.current;
    if (!scroller) return;
    const moved = () => {
      readerMoved.current = true;
    };
    for (const input of readerInput)
      scroller.addEventListener(input, moved, { passive: true });
    return () => {
      for (const input of readerInput)
        scroller.removeEventListener(input, moved);
    };
  }, []);

  /** Scroll the area so `element` is in view, with room above it, unless it already is. */
  const show = useCallback((element: HTMLElement) => {
    const scroller = area.current;
    if (!scroller) return;
    const view = scroller.getBoundingClientRect();
    const box = element.getBoundingClientRect();
    if (box.top >= view.top && box.bottom <= view.bottom) return;
    // Less room above when that keeps a tall target wholly in view.
    const room = Math.max(
      0,
      Math.min(contextAbove, view.height / 4, view.height - box.height),
    );
    // Rounded up, as the area scrolls in whole pixels, so the target's end isn't cut short.
    scroller.scrollTop = Math.max(
      0,
      Math.ceil(scroller.scrollTop + box.top - view.top - room),
    );
  }, []);

  useLayoutEffect(() => {
    const shown = target ? "target" : fallback ? "fallback" : null;
    if (!shown || !ready || readerMoved.current) return;
    if (revealed.current === "target" || revealed.current === shown) return;
    revealed.current = shown;
    show((target ?? fallback)!);
  }, [target, fallback, ready, show]);

  useEffect(() => {
    // After every layout change the resize causes, so the area's new size is measured.
    let frame = 0;
    const keep = () => {
      frame = 0;
      const element = revealed.current === "target" ? target : fallback;
      if (revealed.current && element && !readerMoved.current) show(element);
    };
    const schedule = () => {
      if (!frame) frame = requestAnimationFrame(keep);
    };
    window.addEventListener("resize", schedule);
    return () => {
      cancelAnimationFrame(frame);
      window.removeEventListener("resize", schedule);
    };
  }, [target, fallback, show]);

  return { area, target: setTarget, fallback: setFallback };
}
