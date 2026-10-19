import { messageTextMaxLength } from "@everything/conversation-contracts";
import {
  draftEdit,
  insertTranscript,
  mapSpan,
  type DraftSpan,
} from "./draft-anchor.js";
import { spaceHoldMs } from "./space-hold.js";
import type { VoiceNotice } from "./voice-notice.js";

/**
 * Where dictation stands:
 * - `arming`: Space is held in the composer but recording hasn't started.
 * - `starting`: the microphone has been requested.
 * - `recording`: audio is being captured.
 * - `transcribing`: the recording is finished and its transcript is pending.
 */
export type VoicePhase =
  "idle" | "arming" | "starting" | "recording" | "transcribing";

/** What started the dictation: holding Space in the composer, or holding the microphone button. */
export type VoiceSource = "space" | "button";

/** The Space that began an armed hold, which promotion turns back into the text it replaced. */
export interface PendingSpace {
  /** Where the space was typed. */
  readonly at: number;
  /** End of the selection the space replaced; equal to `at` for a plain caret. */
  readonly end: number;
  /** The selected text the space replaced. */
  readonly original: string;
  /** Whether the space has been typed into the draft and nothing else has changed since. */
  readonly typed: boolean;
}

/** Dictation state that must change together with the draft. */
export interface VoiceState {
  readonly phase: VoicePhase;
  readonly source: VoiceSource | null;
  /** Identifies one dictation; results that arrive for an earlier one are ignored. */
  readonly generation: number;
  /** When the Space hold began, on the event clock. */
  readonly armedAt: number | null;
  readonly pendingSpace: PendingSpace | null;
  /** The part of the draft the transcript replaces, kept in place through every edit. */
  readonly target: DraftSpan | null;
  /** A selection for the field to show after the reducer changed the draft, numbered to apply once. */
  readonly selection: (DraftSpan & { readonly revision: number }) | null;
  readonly notice: VoiceNotice | null;
}

/** The composer's draft and dictation, changed only by the reducer so they never disagree. */
export interface ComposerState {
  readonly draft: string;
  readonly voice: VoiceState;
}

/** Everything that changes the draft or dictation. */
export type ComposerAction =
  /** The user changed the field; `caret` is where the selection ended up. */
  | { readonly type: "edit"; readonly value: string; readonly caret?: number }
  /** A send succeeded; the draft clears only if it is still what was sent. */
  | { readonly type: "sent"; readonly submitted: string }
  /** An ordinary Space that may become a hold was pressed at `at` with this selection. */
  | {
      readonly type: "spaceDown";
      readonly at: number;
      readonly selectionStart: number;
      readonly selectionEnd: number;
    }
  /** Time has passed for the armed hold with this generation. */
  | {
      readonly type: "holdTick";
      readonly generation: number;
      readonly now: number;
    }
  /** The field's selection moved. */
  | { readonly type: "select"; readonly start: number; readonly end: number }
  /** The microphone button was pressed with this field selection. */
  | {
      readonly type: "buttonDown";
      readonly selectionStart: number;
      readonly selectionEnd: number;
    }
  | { readonly type: "recordingStarted"; readonly generation: number }
  /** Recording ended by release or by reaching its limit. */
  | {
      readonly type: "released";
      readonly generation: number;
      readonly notice?: VoiceNotice;
    }
  | {
      readonly type: "transcribed";
      readonly generation: number;
      readonly text: string;
    }
  | {
      readonly type: "failed";
      readonly generation: number;
      readonly notice: VoiceNotice;
    }
  /** Stop any dictation and drop its pending result. */
  | { readonly type: "cancel"; readonly notice?: VoiceNotice }
  | { readonly type: "dismissNotice" };

/** A composer with an empty draft and no dictation. */
export const initialComposerState: ComposerState = {
  draft: "",
  voice: {
    phase: "idle",
    source: null,
    generation: 0,
    armedAt: null,
    pendingSpace: null,
    target: null,
    selection: null,
    notice: null,
  },
};

/** Apply one action; pure, so React may call it more than once. */
export function composerReducer(
  state: ComposerState,
  action: ComposerAction,
): ComposerState {
  const { voice } = state;
  switch (action.type) {
    case "edit":
      return edit(state, action.value, action.caret);
    case "sent":
      return state.draft === action.submitted ? { ...state, draft: "" } : state;
    case "spaceDown":
      if (voice.phase !== "idle") return state;
      return withVoice(state, {
        phase: "arming",
        source: "space",
        generation: voice.generation + 1,
        armedAt: action.at,
        pendingSpace: {
          at: action.selectionStart,
          end: action.selectionEnd,
          original: state.draft.slice(
            action.selectionStart,
            action.selectionEnd,
          ),
          typed: false,
        },
        target: null,
        notice: null,
      });
    case "holdTick":
      if (
        voice.phase !== "arming" ||
        voice.generation !== action.generation ||
        voice.armedAt === null ||
        action.now - voice.armedAt < spaceHoldMs
      )
        return state;
      return promote(state);
    case "select":
      return select(state, action.start, action.end);
    case "buttonDown": {
      if (voice.phase !== "idle") return state;
      const start = clamp(action.selectionStart, state.draft.length);
      const end = clamp(action.selectionEnd, state.draft.length);
      return withVoice(state, {
        phase: "starting",
        source: "button",
        generation: voice.generation + 1,
        armedAt: null,
        pendingSpace: null,
        target: { start: Math.min(start, end), end: Math.max(start, end) },
        notice: null,
      });
    }
    case "recordingStarted":
      return voice.phase === "starting" &&
        voice.generation === action.generation
        ? withVoice(state, { phase: "recording" })
        : state;
    case "released":
      return (voice.phase === "starting" || voice.phase === "recording") &&
        voice.generation === action.generation
        ? withVoice(state, {
            phase: "transcribing",
            notice: action.notice ?? null,
          })
        : state;
    case "transcribed":
      if (
        voice.phase !== "transcribing" ||
        voice.generation !== action.generation ||
        !voice.target
      )
        return state;
      return insert(state, voice.target, action.text);
    case "failed":
      return voice.phase !== "idle" && voice.generation === action.generation
        ? withVoice(state, { ...stopped, notice: action.notice })
        : state;
    case "cancel":
      if (voice.phase === "idle")
        return action.notice
          ? withVoice(state, { notice: action.notice })
          : state;
      return withVoice(state, {
        ...stopped,
        // A new generation guarantees a late result from the cancelled dictation is ignored.
        generation: voice.generation + 1,
        notice: action.notice ?? null,
      });
    case "dismissNotice":
      return voice.notice ? withVoice(state, { notice: null }) : state;
  }
}

/** Dictation fields reset when it ends. */
const stopped = {
  phase: "idle",
  source: null,
  armedAt: null,
  pendingSpace: null,
  target: null,
} as const satisfies Partial<VoiceState>;

/**
 * Take a user edit. While a hold is armed, only the hold's own space may change the draft; any
 * other edit ends the hold and keeps the text as typed. Otherwise the transcript's target follows
 * the edit.
 */
function edit(
  state: ComposerState,
  value: string,
  caret?: number,
): ComposerState {
  const { voice } = state;
  const change = draftEdit(state.draft, value, caret);
  if (!change) return state;
  if (voice.phase === "arming") {
    const pending = voice.pendingSpace;
    const ownSpace =
      !!pending &&
      !pending.typed &&
      change.start === pending.at &&
      change.removed === pending.end - pending.at &&
      change.inserted === 1 &&
      value[pending.at] === " ";
    return ownSpace
      ? {
          draft: value,
          voice: { ...voice, pendingSpace: { ...pending, typed: true } },
        }
      : { draft: value, voice: { ...voice, ...stopped } };
  }
  return {
    draft: value,
    voice: voice.target
      ? { ...voice, target: mapSpan(voice.target, change) }
      : voice,
  };
}

/**
 * Start recording after a full hold. The hold's space is replaced by the text it overwrote and that
 * text is selected again, so the transcript replaces exactly what the user had selected. If the
 * space can't be confirmed as the hold's own, the hold ends and the text stays as typed.
 */
function promote(state: ComposerState): ComposerState {
  const { voice } = state;
  const pending = voice.pendingSpace;
  if (!pending?.typed || state.draft[pending.at] !== " ")
    return withVoice(state, stopped);
  const draft =
    state.draft.slice(0, pending.at) +
    pending.original +
    state.draft.slice(pending.at + 1);
  const target = {
    start: pending.at,
    end: pending.at + pending.original.length,
  };
  return {
    draft,
    voice: {
      ...voice,
      phase: "starting",
      armedAt: null,
      pendingSpace: null,
      target,
      selection: { ...target, revision: (voice.selection?.revision ?? 0) + 1 },
    },
  };
}

/**
 * While a hold is armed, the selection may only be where the Space press left it: unchanged before
 * the space is typed, or just after it once it is. Any other move, such as a click or an arrow key,
 * ends the hold. Moving the selection never relocates a recording's target.
 */
function select(
  state: ComposerState,
  start: number,
  end: number,
): ComposerState {
  const { voice } = state;
  const pending = voice.pendingSpace;
  if (voice.phase !== "arming" || !pending) return state;
  const expected = pending.typed
    ? { start: pending.at + 1, end: pending.at + 1 }
    : { start: pending.at, end: pending.end };
  return start === expected.start && end === expected.end
    ? state
    : withVoice(state, stopped);
}

/** Put a finished transcript at the target, or explain why nothing was added. */
function insert(
  state: ComposerState,
  target: DraftSpan,
  text: string,
): ComposerState {
  const insertion = insertTranscript(
    state.draft,
    target,
    text,
    messageTextMaxLength,
  );
  if ("error" in insertion)
    return withVoice(state, {
      ...stopped,
      notice: insertion.error === "empty" ? "noSpeech" : "doesNotFit",
    });
  return {
    draft: insertion.draft,
    voice: {
      ...state.voice,
      ...stopped,
      notice: "inserted",
      selection: {
        start: insertion.caret,
        end: insertion.caret,
        revision: (state.voice.selection?.revision ?? 0) + 1,
      },
    },
  };
}

/** Replace dictation fields, keeping the draft. */
function withVoice(
  state: ComposerState,
  voice: Partial<VoiceState>,
): ComposerState {
  return { ...state, voice: { ...state.voice, ...voice } };
}

/** Keep a position inside the draft. */
function clamp(position: number, length: number): number {
  return Math.max(0, Math.min(position, length));
}
