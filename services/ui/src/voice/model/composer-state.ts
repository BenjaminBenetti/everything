import { messageTextMaxLength } from "@everything/conversation-contracts";
import {
  absorbEdit,
  draftEdit,
  followSelection,
  insertTranscript,
  mapOwned,
  mapSpan,
  rebaseEdit,
  writeExact,
  writeSpaced,
  type DraftSpan,
  type DraftWrite,
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

/** A partial transcript shown in the draft while a dictation runs. */
export interface LiveText {
  /** The text the target held before the partial replaced it, put back if no transcript replaces it. */
  readonly original: string;
}

/** Dictation state that must change together with the draft. */
export interface VoiceState {
  readonly phase: VoicePhase;
  readonly source: VoiceSource | null;
  /** Identifies one dictation; results that arrive for an earlier one are ignored. */
  readonly generation: number;
  /** When the Space hold began, on the performance clock. */
  readonly armedAt: number | null;
  readonly pendingSpace: PendingSpace | null;
  /**
   * The part of the draft the transcript replaces, kept in place through every edit. While a partial
   * transcript is shown, it is exactly that text, which only the dictation changes.
   */
  readonly target: DraftSpan | null;
  /** The partial transcript the target shows, if any. */
  readonly live: LiveText | null;
  /** The newest partial applied for this dictation; older ones are ignored. */
  readonly revision: number;
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
  /**
   * The user changed the field; `caret` is where the selection ended up. `base` is the draft the
   * field showed when the change was made, and `composing` marks an IME composition update.
   */
  | {
      readonly type: "edit";
      readonly value: string;
      readonly caret?: number;
      readonly base?: string;
      readonly composing?: boolean;
    }
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
  /**
   * A partial transcript arrived. `selection` is the field's selection now; dictation results
   * that change the draft carry it so the caret stays where the user left it.
   */
  | {
      readonly type: "partial";
      readonly generation: number;
      readonly revision: number;
      readonly text: string;
      readonly selection?: DraftSpan;
    }
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
      readonly selection?: DraftSpan;
    }
  | {
      readonly type: "failed";
      readonly generation: number;
      readonly notice: VoiceNotice;
      readonly selection?: DraftSpan;
    }
  /** Stop any dictation and drop its pending result. */
  | {
      readonly type: "cancel";
      readonly notice?: VoiceNotice;
      readonly selection?: DraftSpan;
    }
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
    live: null,
    revision: 0,
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
      return action.base === undefined || action.base === state.draft
        ? edit(state, action.value, action.caret, action.composing)
        : rebased(state, action.base, action.value, action.caret);
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
        live: null,
        revision: 0,
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
        live: null,
        revision: 0,
        notice: null,
      });
    }
    case "recordingStarted":
      return voice.phase === "starting" &&
        voice.generation === action.generation
        ? withVoice(state, { phase: "recording" })
        : state;
    case "partial":
      if (
        (voice.phase !== "starting" &&
          voice.phase !== "recording" &&
          voice.phase !== "transcribing") ||
        voice.generation !== action.generation ||
        action.revision <= voice.revision ||
        !voice.target
      )
        return state;
      return showPartial(state, voice.target, action);
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
      return insert(state, voice.target, action.text, action.selection);
    case "failed":
      return voice.phase !== "idle" && voice.generation === action.generation
        ? restore(state, { notice: action.notice }, action.selection)
        : state;
    case "cancel":
      if (voice.phase === "idle")
        return action.notice
          ? withVoice(state, { notice: action.notice })
          : state;
      return restore(
        state,
        {
          // A new generation guarantees a late result from the cancelled dictation is ignored.
          generation: voice.generation + 1,
          notice: action.notice ?? null,
        },
        action.selection,
      );
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
  live: null,
} as const satisfies Partial<VoiceState>;

/**
 * The draft as the user wrote it: without a partial transcript, which is never sent. With no
 * partial shown, it is the draft itself.
 */
export function committedDraft(state: ComposerState): string {
  const { target, live } = state.voice;
  return target && live
    ? writeExact(state.draft, target, live.original).draft
    : state.draft;
}

/**
 * Take a user edit. While a hold is armed, only the hold's own space may change the draft; any
 * other edit ends the hold and keeps the text as typed. Otherwise the transcript's target follows
 * the edit. A partial transcript in the draft belongs to the dictation until the final replaces it:
 * an edit to it is refused, and the field shows the dictation's text again. An IME composition is
 * never interrupted; text it changes there joins the dictation's text and is replaced with it.
 */
function edit(
  state: ComposerState,
  value: string,
  caret?: number,
  composing = false,
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
  if (voice.target && voice.live) {
    const target = mapOwned(voice.target, change);
    if (target) return { draft: value, voice: { ...voice, target } };
    if (composing)
      return {
        draft: value,
        voice: { ...voice, target: absorbEdit(voice.target, change) },
      };
    // The field shows the dictation's text again, with the caret where the edit was made.
    const at = Math.min(change.start + change.removed, state.draft.length);
    return withVoice(state, {
      selection: { start: at, end: at, revision: nextRevision(voice) },
    });
  }
  return {
    draft: value,
    voice: voice.target
      ? { ...voice, target: mapSpan(voice.target, change) }
      : voice,
  };
}

/**
 * Take a user edit made to a draft the dictation has since changed, as when a keystroke lands just
 * before a partial transcript is shown. The edit is restated against the current draft; if both
 * changed the same text, the draft keeps the dictation's change.
 */
function rebased(
  state: ComposerState,
  base: string,
  value: string,
  caret?: number,
): ComposerState {
  const restated = rebaseEdit(base, value, caret, state.draft);
  if (restated) return edit(state, restated.value, restated.caret);
  const at = Math.min(caret ?? state.draft.length, state.draft.length);
  return withVoice(state, {
    selection: { start: at, end: at, revision: nextRevision(state.voice) },
  });
}

/**
 * Show a partial transcript in place of the target: the selection's text before the first one,
 * and the previous partial afterwards. A blank partial shows the original text again; one that
 * would make the draft too long for a message is skipped, keeping the previous one.
 */
function showPartial(
  state: ComposerState,
  target: DraftSpan,
  partial: {
    readonly revision: number;
    readonly text: string;
    readonly selection?: DraftSpan;
  },
): ComposerState {
  const { voice } = state;
  const original =
    voice.live?.original ?? state.draft.slice(target.start, target.end);
  const text = partial.text.trim();
  if (!text && !voice.live)
    return withVoice(state, { revision: partial.revision });
  const written = text
    ? writeSpaced(state.draft, target, text)
    : writeExact(state.draft, target, original);
  if (written.draft.length > messageTextMaxLength)
    return withVoice(state, { revision: partial.revision });
  return {
    draft: written.draft,
    voice: {
      ...voice,
      target: written.span,
      live: text ? { original } : null,
      revision: partial.revision,
      selection: placed(
        voice,
        partial.selection,
        target,
        written,
        written.span.end,
      ),
    },
  };
}

/**
 * End the dictation, putting back the text a partial transcript replaced. The caret stays where
 * the user left it, or follows the restored text if it was at the partial.
 */
function restore(
  state: ComposerState,
  changes: Partial<VoiceState>,
  selection?: DraftSpan,
): ComposerState {
  const { target, live } = state.voice;
  if (!target || !live) return withVoice(state, { ...stopped, ...changes });
  const written = writeExact(state.draft, target, live.original);
  return {
    draft: written.draft,
    voice: {
      ...state.voice,
      ...stopped,
      ...changes,
      selection: placed(
        state.voice,
        selection,
        target,
        written,
        written.span.end,
      ),
    },
  };
}

/** The field selection to show after the dictation rewrote `from`, numbered to apply once. */
function placed(
  voice: VoiceState,
  selection: DraftSpan | undefined,
  from: DraftSpan,
  written: DraftWrite,
  follow: number,
): VoiceState["selection"] {
  return {
    ...followSelection(selection, from, written.span, follow),
    revision: nextRevision(voice),
  };
}

/** The number for the next selection the reducer sets. */
function nextRevision(voice: VoiceState): number {
  return (voice.selection?.revision ?? 0) + 1;
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
      selection: { ...target, revision: nextRevision(voice) },
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

/**
 * Put the final transcript at the target, replacing any partial transcript there exactly once, or
 * explain why nothing was added and put back the text the partial replaced.
 */
function insert(
  state: ComposerState,
  target: DraftSpan,
  text: string,
  selection?: DraftSpan,
): ComposerState {
  // Spacing depends only on the text around the target, so the transcript replaces a partial there
  // just as it would the original text.
  const insertion = insertTranscript(
    state.draft,
    target,
    text,
    messageTextMaxLength,
  );
  if ("error" in insertion)
    return restore(
      state,
      { notice: insertion.error === "empty" ? "noSpeech" : "doesNotFit" },
      selection,
    );
  // Only the target changed, so what was written ends where the target did, moved by the growth.
  const written: DraftWrite = {
    draft: insertion.draft,
    span: {
      start: target.start,
      end: target.end + insertion.draft.length - state.draft.length,
    },
    textEnd: insertion.caret,
  };
  return {
    draft: insertion.draft,
    voice: {
      ...state.voice,
      ...stopped,
      notice: "inserted",
      selection: placed(
        state.voice,
        selection,
        target,
        written,
        insertion.caret,
      ),
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
