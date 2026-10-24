import {
  useCallback,
  useLayoutEffect,
  useRef,
  useState,
  type RefObject,
} from "react";

/** Most room left above a revealed target, so what leads to it stays in sight. */
const contextAbove = 96;

/** A scrolling area and the target it should bring into view once. */
export interface ScrollReveal<Area extends HTMLElement> {
  /** The scrolling area; only it is scrolled, never the page around it. */
  readonly area: RefObject<Area | null>;
  /** Pass to the area's `onScroll`, so a reader's own scrolling is respected. */
  readonly onScroll: () => void;
  /** A callback ref for the target, which may appear after the area, as data arrives. */
  readonly target: (element: HTMLElement | null) => void;
}

/**
 * Bring a target into its scrolling area's view once, when it first appears and `ready` is true,
 * with a little room above it. Only the area is scrolled, without animation, so the page around it
 * never moves. Nothing is scrolled after that, so data refreshing in place never moves what the
 * reader is looking at, nor when the reader has already scrolled the area themselves.
 */
export function useScrollReveal<Area extends HTMLElement>(
  ready: boolean,
): ScrollReveal<Area> {
  const area = useRef<Area>(null);
  const [target, setTarget] = useState<HTMLElement | null>(null);
  const settled = useRef(false);
  const scrolling = useRef(false);
  useLayoutEffect(() => {
    const scroller = area.current;
    if (!scroller || !target || !ready || settled.current) return;
    settled.current = true;
    const view = scroller.getBoundingClientRect();
    const box = target.getBoundingClientRect();
    if (box.top >= view.top && box.bottom <= view.bottom) return;
    const room = Math.min(contextAbove, view.height / 4);
    const top = Math.max(0, scroller.scrollTop + box.top - view.top - room);
    if (Math.abs(top - scroller.scrollTop) < 1) return;
    scrolling.current = true;
    scroller.scrollTop = top;
  }, [target, ready]);
  const onScroll = useCallback(() => {
    // The scroll this hook made; any other is the reader's, after which nothing is revealed.
    if (scrolling.current) scrolling.current = false;
    else settled.current = true;
  }, []);
  return { area, onScroll, target: setTarget };
}
