import { useLayoutEffect, useRef } from "react";

/** The parts of a text field and its container that sizing reads and writes. */
export interface SizedField {
  readonly style: { height: string };
  readonly scrollHeight: number;
  readonly parentElement: {
    readonly style: { minHeight: string };
    getBoundingClientRect(): { readonly height: number };
  } | null;
}

/**
 * Set a field's height to its content's. The field collapses to be measured, so its container
 * keeps its height meanwhile: a shorter composer would make the conversation above it taller for
 * that layout, and the browser would pull the conversation's scroll position up to fit. The
 * restored composer would then hide the end of the latest message, and because the conversation
 * ends the same size, nothing would scroll it back.
 */
export function fitToContent(field: SizedField): void {
  const container = field.parentElement;
  const reserved = container?.style.minHeight ?? "";
  if (container)
    container.style.minHeight = `${container.getBoundingClientRect().height}px`;
  field.style.height = "0px";
  field.style.height = `${field.scrollHeight}px`;
  if (container) container.style.minHeight = reserved;
}

/** Grow a draft to its content while CSS caps its height and keeps long drafts scrollable. */
export function useComposerSize(draft: string) {
  const ref = useRef<HTMLTextAreaElement>(null);
  useLayoutEffect(() => {
    const field = ref.current;
    if (!field) return;
    let width = field.clientWidth;

    // Measure natural content height again after typing, clearing, or changing width.
    fitToContent(field);
    const observer = new ResizeObserver(() => {
      if (field.clientWidth === width) return;
      width = field.clientWidth;
      fitToContent(field);
    });
    observer.observe(field);
    return () => observer.disconnect();
  }, [draft]);
  return ref;
}
