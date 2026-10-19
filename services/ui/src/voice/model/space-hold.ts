import type { VoiceState } from "./composer-state.js";

/** How long Space must be held in the composer before recording starts. */
export const spaceHoldMs = 1000;

/** The keyboard event fields the Space gesture reads. */
export interface KeyFacts {
  readonly key: string;
  readonly repeat: boolean;
  readonly isComposing: boolean;
  readonly keyCode: number;
  readonly ctrlKey: boolean;
  readonly altKey: boolean;
  readonly metaKey: boolean;
  readonly shiftKey: boolean;
}

/**
 * What a keydown in the composer does to the gesture:
 * - `arm`: an ordinary Space that may become a hold; it still types its space.
 * - `suppress`: a repeat or stray Space while armed or recording; it must not type.
 * - `cancel`: Escape stops an active dictation, unless an IME composition is using it.
 * - `disarm`: any other key ends an armed hold; the key keeps its normal effect.
 * - `none`: not part of the gesture.
 */
export type SpaceKeyDown = "arm" | "suppress" | "cancel" | "disarm" | "none";

/** What a Space keyup does: `disarm` a short press, `release` a recording, or nothing. */
export type SpaceKeyUp = "disarm" | "release" | "none";

/** IME-processed keys report this key code while a composition may be starting. */
const imeKeyCode = 229;

/**
 * Decide how a composer keydown affects the Space gesture. `spaceHeld` is true while the Space press
 * that armed a hold is still down, even after its dictation ended, so its repeats never type.
 */
export function spaceKeyDown(
  voice: Pick<VoiceState, "phase" | "source">,
  event: KeyFacts,
  holdEnabled: boolean,
  spaceHeld = false,
): SpaceKeyDown {
  if (event.key === "Escape" && voice.phase !== "idle" && !event.isComposing)
    return "cancel";
  const space = event.key === " ";
  if (space && event.repeat && spaceHeld) return "suppress";
  if (voice.source === "space" && space)
    if (voice.phase === "starting" || voice.phase === "recording")
      return "suppress";
    else if (voice.phase === "arming" && event.repeat) return "suppress";
  if (voice.phase === "arming") return "disarm";
  if (
    holdEnabled &&
    voice.phase === "idle" &&
    space &&
    !event.repeat &&
    !event.isComposing &&
    event.keyCode !== imeKeyCode &&
    !event.ctrlKey &&
    !event.altKey &&
    !event.metaKey &&
    !event.shiftKey
  )
    return "arm";
  return "none";
}

/** Decide how a composer keyup affects the Space gesture. */
export function spaceKeyUp(
  voice: Pick<VoiceState, "phase" | "source">,
  key: string,
): SpaceKeyUp {
  if (key !== " " || voice.source !== "space") return "none";
  if (voice.phase === "arming") return "disarm";
  if (voice.phase === "starting" || voice.phase === "recording")
    return "release";
  return "none";
}
