import { useReducer, type FormEvent, type KeyboardEvent } from "react";
import { ArrowUp } from "lucide-react";
import { Button } from "@everything/ui/button";
import { InputSurface } from "@everything/ui/input-surface";
import { messageTextMaxLength } from "@everything/conversation-contracts";
import { useComposerSize } from "../hook/use-composer-size.js";
import {
  composerReducer,
  initialComposerState,
} from "../../voice/model/composer-state.js";
import { useVoiceInput } from "../../voice/hook/use-voice-input.js";
import {
  VoiceButton,
  VoiceStatus,
  voiceStatusId,
} from "../../voice/component/voice-controls.js";

/**
 * Size the field to its draft, keep failed sends editable, and expose sending as an explicit action.
 * Dictation adds its transcript to the draft for review; it never sends.
 */
export function MessageComposer({
  agentId,
  name,
  disabled,
  sending,
  onSend,
}: {
  agentId: string;
  name: string;
  disabled: boolean;
  sending: boolean;
  onSend: (text: string) => Promise<unknown>;
}) {
  const [{ draft, voice }, dispatch] = useReducer(
    composerReducer,
    initialComposerState,
  );
  const field = useComposerSize(draft);
  const dictation = useVoiceInput({
    agentId,
    field,
    voice,
    dispatch,
    disabled,
  });
  const canSend = !!draft.trim() && !disabled && !sending;

  /** Clear only the submitted draft after persistence succeeds, retaining text typed during the request. */
  async function submit(event: FormEvent<HTMLFormElement>): Promise<void> {
    event.preventDefault();
    if (!canSend) return;
    // A recording made for this draft is no longer wanted once the draft is sent.
    dictation.cancel();
    const submitted = draft;
    try {
      await onSend(submitted.trim());
      dispatch({ type: "sent", submitted });
    } catch {
      // The conversation controller presents the failed request; the draft remains editable.
    }
  }

  /** Enter sends, Shift+Enter inserts a line, and IME composition never submits. */
  function keyDown(event: KeyboardEvent<HTMLTextAreaElement>): void {
    if (dictation.keyDown(event)) return;
    if (
      event.key === "Enter" &&
      !event.shiftKey &&
      !event.nativeEvent.isComposing
    ) {
      event.preventDefault();
      if (canSend) event.currentTarget.form?.requestSubmit();
    }
  }

  return (
    <InputSurface
      as="form"
      className="chat-composer"
      onSubmit={(event) => void submit(event)}
    >
      {dictation.offered && <VoiceStatus voice={voice} />}
      <label className="sr-only" htmlFor="chat-message">
        Message {name}
      </label>
      <textarea
        id="chat-message"
        ref={field}
        rows={1}
        value={draft}
        onChange={(event) =>
          dispatch({
            type: "edit",
            value: event.target.value,
            caret: event.target.selectionEnd,
          })
        }
        onKeyDown={keyDown}
        onKeyUp={dictation.keyUp}
        onSelect={dictation.select}
        onBlur={dictation.blur}
        onCompositionStart={dictation.interrupt}
        onPointerDown={dictation.interrupt}
        maxLength={messageTextMaxLength}
        disabled={disabled}
        placeholder={`Message ${name}…`}
        aria-describedby={
          dictation.offered ? `composer-help ${voiceStatusId}` : "composer-help"
        }
      />
      <div className="chat-composer-actions">
        <p id="composer-help">
          Enter to send · Shift+Enter for a new line
          {dictation.holdEnabled && " · Hold Space for 3 seconds to record"}
        </p>
        {dictation.offered && (
          <VoiceButton
            voice={voice}
            blocker={dictation.blocker}
            ready={dictation.ready}
            buttonProps={dictation.buttonProps}
          />
        )}
        <Button type="submit" disabled={!canSend} aria-label="Send message">
          <ArrowUp aria-hidden="true" />
          <span>{sending ? "Sending…" : "Send"}</span>
        </Button>
      </div>
    </InputSurface>
  );
}
