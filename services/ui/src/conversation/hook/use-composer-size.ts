import { useLayoutEffect, useRef } from "react";

/** Grow a draft to its content while CSS caps its height and keeps long drafts scrollable. */
export function useComposerSize(draft: string) {
  const ref = useRef<HTMLTextAreaElement>(null);
  useLayoutEffect(() => {
    const field = ref.current;
    if (!field) return;
    let width = field.clientWidth;

    /** Measure natural content height again after typing, clearing, or changing width. */
    function resize(): void {
      if (!field) return;
      field.style.height = "0px";
      field.style.height = `${field.scrollHeight}px`;
    }

    resize();
    const observer = new ResizeObserver(() => {
      if (field.clientWidth === width) return;
      width = field.clientWidth;
      resize();
    });
    observer.observe(field);
    return () => observer.disconnect();
  }, [draft]);
  return ref;
}
