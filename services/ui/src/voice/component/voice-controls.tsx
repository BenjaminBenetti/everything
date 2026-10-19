import { LoaderCircle, Mic, MicOff } from "lucide-react";
import { IconButton } from "@everything/ui/button";
import type { VoiceState } from "../model/composer-state.js";
import {
  voiceNoticeText,
  voiceProblems,
  type VoiceNotice,
} from "../model/voice-notice.js";

/** The id the composer's field and button use to reference the dictation status. */
export const voiceStatusId = "voice-status";

/** The problem the last dictation ended with, while nothing else is happening. */
function idleProblem(voice: VoiceState): VoiceNotice | null {
  return voice.phase === "idle" &&
    voice.notice &&
    voiceProblems.has(voice.notice)
    ? voice.notice
    : null;
}

/** The microphone button's name for each state, which also serves as its tooltip. */
function buttonLabel(voice: VoiceState, blocker: VoiceNotice | null): string {
  if (blocker) return voiceNoticeText[blocker];
  const problem = idleProblem(voice);
  if (problem) return voiceNoticeText[problem];
  switch (voice.phase) {
    case "starting":
      return "Starting the microphone";
    case "recording":
      return "Recording. Release to add your words to the message";
    case "transcribing":
      return "Transcribing your recording";
    default:
      return "Hold to record a message";
  }
}

/**
 * Hold-to-record microphone button; it never listens unless held. Its icon and state show what
 * dictation is doing, and a problem is marked on it and named in its label and tooltip.
 */
export function VoiceButton({
  voice,
  blocker,
  ready,
  buttonProps,
}: {
  voice: VoiceState;
  blocker: VoiceNotice | null;
  ready: boolean;
  buttonProps: Record<string, unknown>;
}) {
  const busy = voice.phase === "starting" || voice.phase === "transcribing";
  return (
    <IconButton
      {...buttonProps}
      label={buttonLabel(voice, blocker)}
      className="voice-button"
      data-state={voice.phase}
      data-problem={idleProblem(voice) ? true : undefined}
      // A button-held recording keeps working; the button is only unavailable when it can't start.
      disabled={!ready && voice.phase === "idle"}
      aria-describedby={voiceStatusId}
    >
      {blocker ? (
        <MicOff aria-hidden="true" />
      ) : busy ? (
        <LoaderCircle aria-hidden="true" className="voice-spinner" />
      ) : (
        <Mic aria-hidden="true" />
      )}
    </IconButton>
  );
}

/** What the composer is doing with a dictation, or how the last one ended. */
function statusText(voice: VoiceState): string {
  switch (voice.phase) {
    case "starting":
      return "Starting the microphone… Allow access if your browser asks.";
    case "recording":
      return voice.source === "space"
        ? "Recording… Release Space to add your words, or press Escape to cancel."
        : "Recording… Release to add your words.";
    case "transcribing":
      return voice.notice
        ? voiceNoticeText[voice.notice]
        : "Transcribing your recording…";
    default:
      // An armed hold says nothing, so ordinary typing is never announced.
      return voice.notice ? voiceNoticeText[voice.notice] : "";
  }
}

/**
 * Dictation status for screen readers only; it stays in place so changes are announced. On screen,
 * the microphone button carries it.
 */
export function VoiceStatus({ voice }: { voice: VoiceState }) {
  const problem = !!idleProblem(voice);
  return (
    <p
      id={voiceStatusId}
      className="sr-only"
      role="status"
      aria-live={problem ? "assertive" : "polite"}
      data-problem={problem || undefined}
    >
      {statusText(voice)}
    </p>
  );
}
