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

/** The microphone button's name for each state, which also serves as its tooltip. */
function buttonLabel(voice: VoiceState, blocker: VoiceNotice | null): string {
  if (blocker) return voiceNoticeText[blocker];
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

/** Hold-to-record microphone button; it never listens unless held. */
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

/** A live status line for dictation; it stays in place so screen readers announce changes. */
export function VoiceStatus({ voice }: { voice: VoiceState }) {
  const problem =
    voice.phase === "idle" && !!voice.notice && voiceProblems.has(voice.notice);
  return (
    <p
      id={voiceStatusId}
      className="voice-status"
      role="status"
      aria-live={problem ? "assertive" : "polite"}
      data-problem={problem || undefined}
    >
      {statusText(voice)}
    </p>
  );
}
