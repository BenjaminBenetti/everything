import {
  useCallback,
  useEffect,
  useLayoutEffect,
  useRef,
  type Dispatch,
  type FocusEvent as ReactFocusEvent,
  type KeyboardEvent,
  type MouseEvent,
  type PointerEvent,
  type RefObject,
} from "react";
import type { VoiceCapabilities } from "@everything/conversation-contracts/voice";
import { useVoice, useVoiceCapabilities } from "../component/voice-provider.js";
import type { ComposerAction, VoiceState } from "../model/composer-state.js";
import { recordingType, uploadType } from "../model/recording-format.js";
import { spaceHoldMs, spaceKeyDown, spaceKeyUp } from "../model/space-hold.js";
import { noticeOf } from "../model/voice-input-error.js";
import { voiceProblems, type VoiceNotice } from "../model/voice-notice.js";
import { MicrophoneRecorder } from "../service/microphone-recorder.js";
import { RecordingBuffer } from "../service/recording-buffer.js";

/** A button press shorter than this is treated as a tap, not a recording. */
const minimumPressMs = 300;

/** Recording stops this long before the server's limit, leaving room for encoder padding. */
const recordingMarginMs = 500;

/** Extra time the browser allows a transcription request beyond the server's own limit. */
const networkMarginMs = 15_000;

/** Informational notices clear themselves after this long; problems stay until the next action. */
const noticeLifetimeMs = 6_000;

/** One dictation's microphone and request, matched to the reducer by generation. */
interface Session {
  readonly generation: number;
  readonly buffer: RecordingBuffer;
  readonly recorder: MicrophoneRecorder;
  request: AbortController | null;
  releasing: boolean;
}

/** A press of the microphone button, by pointer or by keyboard. */
interface Press {
  readonly pointerId: number | null;
  readonly startedAt: number;
}

/** What the composer needs from the dictation it hosts. */
interface VoiceInputOptions {
  readonly agentId: string;
  readonly field: RefObject<HTMLTextAreaElement | null>;
  readonly voice: VoiceState;
  readonly dispatch: Dispatch<ComposerAction>;
  readonly disabled: boolean;
}

/**
 * Connect the composer's dictation state to the microphone and the transcription service. The
 * reducer decides every change to the draft; this hook only starts and stops the recorder and the
 * request for the current generation, and drops anything that arrives for an earlier one.
 */
export function useVoiceInput({
  agentId,
  field,
  voice,
  dispatch,
  disabled,
}: VoiceInputOptions) {
  const { client, media } = useVoice();
  const capabilities = useVoiceCapabilities().data;
  const offered = !!capabilities?.available;
  const type =
    offered && !media.blocker
      ? recordingType(media.isTypeSupported, capabilities.mediaTypes)
      : null;
  const blocker: VoiceNotice | null = !offered
    ? null
    : media.blocker === "insecure"
      ? "needsSecureConnection"
      : !type
        ? "unsupported"
        : null;
  const ready = offered && !blocker && !disabled;
  const holdEnabled = ready && hasFinePointer();
  const session = useRef<Session | null>(null);
  const press = useRef<Press | null>(null);
  // The Space press that armed a hold is still down; its repeats must not type.
  const spaceHeld = useRef(false);

  // ===========================================
  // Session control
  // ===========================================

  /** Stop the current dictation's microphone and request and drop its result. */
  const cancel = useCallback(
    (notice?: VoiceNotice) => {
      const current = session.current;
      session.current = null;
      press.current = null;
      current?.recorder.cancel();
      current?.request?.abort();
      dispatch({ type: "cancel", ...(notice ? { notice } : {}) });
    },
    [dispatch],
  );

  /** End a session with an outcome, if it is still the current one. */
  const fail = useCallback(
    (current: Session, notice: VoiceNotice) => {
      if (session.current !== current) return;
      session.current = null;
      current.recorder.cancel();
      dispatch({ type: "failed", generation: current.generation, notice });
    },
    [dispatch],
  );

  /** Finish recording and send the recording once for its final transcript. */
  const release = useCallback(
    (current: Session, notice?: VoiceNotice) => {
      if (session.current !== current || current.releasing) return;
      current.releasing = true;
      const { generation } = current;
      dispatch({ type: "released", generation, ...(notice ? { notice } : {}) });
      void current.recorder.finish().then(
        async (end) => {
          if (session.current !== current) return;
          const contentType =
            end && capabilities && type
              ? uploadType(end.type, type, capabilities.mediaTypes)
              : null;
          const audio = end && contentType && current.buffer.take(contentType);
          current.buffer.discard();
          if (!audio)
            return fail(
              current,
              end && !contentType ? "unsupported" : "tooShort",
            );
          const request = new AbortController();
          current.request = request;
          try {
            const text = await client.transcribe(
              agentId,
              audio,
              withTimeout(request.signal, responseTimeout(capabilities)),
            );
            if (session.current !== current) return;
            session.current = null;
            dispatch({ type: "transcribed", generation, text });
          } catch (error) {
            fail(current, noticeOf(error));
          }
        },
        (error: unknown) => fail(current, noticeOf(error)),
      );
    },
    [agentId, capabilities, client, dispatch, fail, type],
  );

  // ===========================================
  // State-driven effects
  // ===========================================

  // An armed Space hold becomes a recording once it has lasted long enough.
  useEffect(() => {
    if (voice.phase !== "arming" || voice.armedAt === null) return;
    const { generation, armedAt } = voice;
    let timer: ReturnType<typeof setTimeout>;
    /** Timers can fire a little early; check the elapsed time and wait again if needed. */
    const check = (): void => {
      const now = performance.now();
      if (now - armedAt >= spaceHoldMs)
        dispatch({ type: "holdTick", generation, now });
      else timer = setTimeout(check, spaceHoldMs - (now - armedAt));
    };
    timer = setTimeout(
      check,
      Math.max(0, spaceHoldMs - (performance.now() - armedAt)),
    );
    return () => clearTimeout(timer);
  }, [voice.phase, voice.generation, voice.armedAt, dispatch]);

  // Each dictation that reaches `starting` gets exactly one recorder.
  useEffect(() => {
    if (voice.phase !== "starting") return;
    if (session.current?.generation === voice.generation) return;
    const { generation } = voice;
    if (!capabilities || !type) {
      dispatch({
        type: "failed",
        generation,
        notice: blocker ?? "unavailable",
      });
      return;
    }
    const buffer = new RecordingBuffer();
    const current: Session = {
      generation,
      buffer,
      recorder: new MicrophoneRecorder(media, buffer, {
        type,
        maxBytes: capabilities.maxBytes,
        maxDurationMs: capabilities.maxDurationMs - recordingMarginMs,
        onLimit: () => release(current, "limitReached"),
        onFailure: (error) => fail(current, error.notice),
      }),
      request: null,
      releasing: false,
    };
    session.current = current;
    current.recorder.start().then(
      (recording) => {
        if (recording && session.current === current)
          dispatch({ type: "recordingStarted", generation });
      },
      (error: unknown) => fail(current, noticeOf(error)),
    );
  }, [
    voice.phase,
    voice.generation,
    capabilities,
    type,
    blocker,
    media,
    dispatch,
    release,
    fail,
  ]);

  // Leaving the page or the window, focus moving outside the composer, or the composer becoming
  // unavailable stops a dictation. Moving between the field and the composer's buttons does not.
  const active = voice.phase !== "idle";
  useEffect(() => {
    if (!active) return;
    const stop = (): void => cancel();
    const visibility = (): void => {
      if (document.visibilityState === "hidden") cancel();
    };
    const focusIn = (event: FocusEvent): void => {
      const composer = field.current?.form;
      if (
        composer &&
        event.target instanceof Node &&
        !composer.contains(event.target)
      )
        cancel();
    };
    window.addEventListener("blur", stop);
    window.addEventListener("pagehide", stop);
    document.addEventListener("visibilitychange", visibility);
    document.addEventListener("focusin", focusIn);
    return () => {
      window.removeEventListener("blur", stop);
      window.removeEventListener("pagehide", stop);
      document.removeEventListener("visibilitychange", visibility);
      document.removeEventListener("focusin", focusIn);
    };
  }, [active, cancel, field]);

  useEffect(() => {
    if (disabled && active) cancel();
  }, [disabled, active, cancel]);

  // Leaving the conversation, including switching teammates, releases the microphone and request.
  useEffect(
    () => () => {
      const current = session.current;
      session.current = null;
      current?.recorder.cancel();
      current?.request?.abort();
    },
    [],
  );

  // Show the selection the reducer chose after changing the draft.
  const revision = voice.selection?.revision;
  useLayoutEffect(() => {
    const element = field.current;
    if (!voice.selection || !element) return;
    element.setSelectionRange(voice.selection.start, voice.selection.end);
    // The revision identifies a new selection; the object is replaced with every state change.
  }, [revision]);

  // Informational notices clear themselves; problems stay until the next dictation.
  const notice = voice.notice;
  useEffect(() => {
    if (!notice || voiceProblems.has(notice) || active) return;
    const timer = setTimeout(
      () => dispatch({ type: "dismissNotice" }),
      noticeLifetimeMs,
    );
    return () => clearTimeout(timer);
  }, [notice, active, dispatch]);

  // ===========================================
  // Composer field events
  // ===========================================

  /** Handle the Space gesture and Escape; true when the event must go no further. */
  function keyDown(event: KeyboardEvent<HTMLTextAreaElement>): boolean {
    const decision = spaceKeyDown(
      voice,
      event.nativeEvent,
      holdEnabled,
      spaceHeld.current,
    );
    switch (decision) {
      case "cancel":
        event.preventDefault();
        event.stopPropagation();
        cancel("cancelled");
        return true;
      case "suppress":
        event.preventDefault();
        return true;
      case "disarm":
        cancel();
        return false;
      case "arm":
        spaceHeld.current = true;
        dispatch({
          type: "spaceDown",
          at: event.timeStamp,
          selectionStart: event.currentTarget.selectionStart,
          selectionEnd: event.currentTarget.selectionEnd,
        });
        return false;
      case "none":
        return false;
    }
  }

  /** Releasing Space ends a short press as ordinary typing, or a recording to transcribe it. */
  function keyUp(event: KeyboardEvent<HTMLTextAreaElement>): void {
    if (event.key === " ") spaceHeld.current = false;
    const decision = spaceKeyUp(voice, event.key);
    if (decision === "disarm") cancel();
    else if (decision === "release") releaseCurrent();
  }

  /** Report selection moves while a hold is armed. */
  function select(event: { currentTarget: HTMLTextAreaElement }): void {
    if (voice.phase !== "arming") return;
    dispatch({
      type: "select",
      start: event.currentTarget.selectionStart,
      end: event.currentTarget.selectionEnd,
    });
  }

  /**
   * A Space dictation needs the field's focus to see Space released. Any dictation stops when focus
   * leaves the composer, including to nothing, as when clicking an empty part of the page.
   */
  function blur(event: ReactFocusEvent<HTMLTextAreaElement>): void {
    spaceHeld.current = false;
    if (!active) return;
    const next = event.relatedTarget;
    const composer = event.currentTarget.form;
    if (
      voice.source === "space" ||
      !(next instanceof Node) ||
      !composer?.contains(next)
    )
      cancel();
  }

  /** Composition and pointer input end an armed hold. */
  function interrupt(): void {
    if (voice.phase === "arming") cancel();
  }

  /** Release the current recording, or treat a release before it began as a tap. */
  function releaseCurrent(): void {
    const current = session.current;
    if (current && current.generation === voice.generation) release(current);
    else cancel("tooShort");
  }

  // ===========================================
  // Microphone button events
  // ===========================================

  /** Begin a button dictation at the composer's current selection. */
  function beginPress(pointerId: number | null, startedAt: number): boolean {
    if (!ready || active || press.current) return false;
    const element = field.current;
    const end = element?.value.length ?? 0;
    dispatch({
      type: "buttonDown",
      selectionStart: element?.selectionStart ?? end,
      selectionEnd: element?.selectionEnd ?? end,
    });
    press.current = { pointerId, startedAt };
    return true;
  }

  /** End a press: a tap explains how to record, a hold is transcribed. */
  function endPress(endedAt: number): void {
    const current = press.current;
    press.current = null;
    if (!current) return;
    if (endedAt - current.startedAt < minimumPressMs) cancel("tooShort");
    else releaseCurrent();
  }

  const buttonProps = {
    onPointerDown(event: PointerEvent<HTMLButtonElement>) {
      if (event.button !== 0) return;
      // Keep the composer's focus, caret, and on-screen keyboard; prevent text selection.
      event.preventDefault();
      if (!beginPress(event.pointerId, event.timeStamp)) return;
      try {
        // Keep receiving the release even if the finger or pointer slides off the button.
        event.currentTarget.setPointerCapture(event.pointerId);
      } catch {
        // The pointer is already gone; its release or cancellation still ends the press.
      }
    },
    onPointerUp(event: PointerEvent<HTMLButtonElement>) {
      if (press.current?.pointerId === event.pointerId)
        endPress(event.timeStamp);
    },
    onPointerCancel(event: PointerEvent<HTMLButtonElement>) {
      if (press.current?.pointerId === event.pointerId) cancel();
    },
    onLostPointerCapture(event: PointerEvent<HTMLButtonElement>) {
      // Fires after pointerup too, by which time the press has already ended.
      if (press.current?.pointerId === event.pointerId) cancel();
    },
    onContextMenu(event: MouseEvent<HTMLButtonElement>) {
      event.preventDefault();
    },
    onClick(event: MouseEvent<HTMLButtonElement>) {
      event.preventDefault();
    },
    onKeyDown(event: KeyboardEvent<HTMLButtonElement>) {
      if (event.key === "Escape" && active) {
        event.preventDefault();
        cancel("cancelled");
      } else if (event.key === " " || event.key === "Enter") {
        event.preventDefault();
        if (!event.repeat) beginPress(null, event.timeStamp);
      }
    },
    onKeyUp(event: KeyboardEvent<HTMLButtonElement>) {
      if (
        (event.key === " " || event.key === "Enter") &&
        press.current?.pointerId === null
      ) {
        event.preventDefault();
        endPress(event.timeStamp);
      }
    },
    onBlur(event: ReactFocusEvent<HTMLButtonElement>) {
      const next = event.relatedTarget;
      const composer = event.currentTarget.form;
      if (
        press.current?.pointerId === null ||
        (active && !(next instanceof Node && composer?.contains(next)))
      )
        cancel();
    },
  };

  return {
    /** Whether this installation offers voice input at all. */
    offered,
    /** Whether a recording can start now. */
    ready,
    /** Why recording can't work in this browser, when it can't. */
    blocker,
    /** Whether holding Space in the composer records. */
    holdEnabled,
    keyDown,
    keyUp,
    select,
    blur,
    interrupt,
    /** Stop any dictation, as sending a message does. */
    cancel,
    buttonProps,
  };
}

/** The longest a transcription request may take, per the server's own limits. */
function responseTimeout(capabilities: VoiceCapabilities | undefined): number {
  return (capabilities?.responseTimeoutMs ?? 0) + networkMarginMs;
}

/** A signal that aborts with the given one or after a delay, also where `AbortSignal.any` is missing. */
function withTimeout(signal: AbortSignal, timeoutMs: number): AbortSignal {
  const timeout = AbortSignal.timeout(timeoutMs);
  if (typeof AbortSignal.any === "function")
    return AbortSignal.any([signal, timeout]);
  const combined = new AbortController();
  const abort = (): void => combined.abort();
  signal.addEventListener("abort", abort, { once: true });
  timeout.addEventListener("abort", abort, { once: true });
  return combined.signal;
}

/** Whether the main pointer can hover precisely, as with a mouse or trackpad beside a keyboard. */
function hasFinePointer(): boolean {
  return (
    window.matchMedia?.("(hover: hover) and (pointer: fine)").matches ?? false
  );
}
