import { useEffect, useState } from "react";

/** The visible screen while a keyboard covers part of the layout viewport. */
export interface ChatViewport {
  /** Height of the visible screen above the keyboard. */
  readonly height: number;
  /** How far iOS panned the page up to reveal the focused input. */
  readonly offsetTop: number;
}

/** Follow the visible screen while a phone keyboard covers part of the layout viewport. */
export function useChatViewport(enabled: boolean): ChatViewport | undefined {
  const [viewport, setViewport] = useState<ChatViewport>();
  useEffect(() => {
    const visual = window.visualViewport;
    if (!enabled || !visual) return;

    /** Leave pinch zoom alone and follow only the screen and keyboard. */
    function update(): void {
      if (visual?.scale === 1)
        setViewport({ height: visual.height, offsetTop: visual.offsetTop });
    }

    update();
    // The keyboard resizes the visible screen, and iOS pans it when an input is focused;
    // the shell must follow both to keep the composer attached to the keyboard.
    visual.addEventListener("resize", update);
    visual.addEventListener("scroll", update);
    return () => {
      visual.removeEventListener("resize", update);
      visual.removeEventListener("scroll", update);
    };
  }, [enabled]);
  return enabled ? viewport : undefined;
}
