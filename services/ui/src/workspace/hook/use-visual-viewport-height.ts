import { useEffect, useState } from "react";

/** Follow the visible screen while a phone keyboard covers part of the layout viewport. */
export function useVisualViewportHeight(enabled: boolean): number | undefined {
  const [height, setHeight] = useState<number>();
  useEffect(() => {
    const viewport = window.visualViewport;
    if (!enabled || !viewport) return;

    /** Leave pinch zoom alone and resize only when the screen or keyboard changes. */
    function update(): void {
      if (viewport?.scale === 1) setHeight(viewport.height);
    }

    update();
    viewport.addEventListener("resize", update);
    return () => viewport.removeEventListener("resize", update);
  }, [enabled]);
  return enabled ? height : undefined;
}
