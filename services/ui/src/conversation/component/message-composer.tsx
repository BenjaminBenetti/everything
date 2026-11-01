import {
  useEffect,
  useReducer,
  useRef,
  useState,
  type ClipboardEvent,
  type DragEvent,
  type FormEvent,
  type KeyboardEvent,
} from "react";
import { ArrowUp, Paperclip } from "lucide-react";
import { Button, IconButton } from "@everything/ui/button";
import { InputSurface } from "@everything/ui/input-surface";
import { messageTextMaxLength } from "@everything/conversation-contracts";
import { useComposerSize } from "../hook/use-composer-size.js";
import {
  committedDraft,
  composerReducer,
  initialComposerState,
} from "../../voice/model/composer-state.js";
import { useVoiceInput } from "../../voice/hook/use-voice-input.js";
import {
  VoiceButton,
  VoiceStatus,
  voiceStatusId,
} from "../../voice/component/voice-controls.js";
import { useAttachmentDrafts } from "../hook/use-attachment-drafts.js";
import { ComposerAttachments } from "./composer-attachments.js";
import type { MessageInput } from "../interface/conversation-client.js";

/** Whether a drag carries files from the computer, rather than text or a link. */
function carriesFiles(event: DragEvent): boolean {
  return [...event.dataTransfer.types].includes("Files");
}

/**
 * Size the field to its draft, keep failed sends editable, and expose sending as an explicit action.
 * Dictation shows its words in the draft while it listens and adds its final transcript for review;
 * it never sends, and its provisional words are never part of what is sent. Files are attached with
 * the paperclip, by dropping them on the composer, or by pasting them; sending waits until every file
 * has uploaded, and a message can be only files.
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
  onSend: (input: MessageInput) => Promise<unknown>;
}) {
  const [composer, dispatch] = useReducer(
    composerReducer,
    initialComposerState,
  );
  const { draft, voice } = composer;
  // What the user wrote, without a dictation's provisional words.
  const written = committedDraft(composer);
  const field = useComposerSize(draft);
  const dictation = useVoiceInput({
    agentId,
    field,
    voice,
    dispatch,
    disabled,
  });
  const attachments = useAttachmentDrafts(agentId);
  const picker = useRef<HTMLInputElement>(null);
  const [dragging, setDragging] = useState(false);
  const waiting = attachments.uploading > 0;
  const stopped = attachments.failed > 0;
  const canSend =
    (!!written.trim() || attachments.readyIds.length > 0) &&
    !waiting &&
    !stopped &&
    !disabled &&
    !sending;
  useEffect(() => {
    /** A file dropped beside the composer would otherwise open in the tab and lose the draft. */
    function ignoreFileDrop(event: globalThis.DragEvent): void {
      if (event.dataTransfer?.types.includes("Files")) event.preventDefault();
    }
    window.addEventListener("dragover", ignoreFileDrop);
    window.addEventListener("drop", ignoreFileDrop);
    return () => {
      window.removeEventListener("dragover", ignoreFileDrop);
      window.removeEventListener("drop", ignoreFileDrop);
    };
  }, []);
  const attachmentStatus = waiting
    ? "Uploading files. You can send when they finish."
    : stopped
      ? "Retry or remove files that didn’t upload to send."
      : "";

  /** Clear only the submitted draft after persistence succeeds, retaining text typed during the request. */
  async function submit(event: FormEvent<HTMLFormElement>): Promise<void> {
    event.preventDefault();
    if (!canSend) return;
    // A recording made for this draft is no longer wanted once the draft is sent; cancelling takes
    // its provisional words out of the draft.
    dictation.cancel();
    const submitted = written;
    const files = attachments.readyKeys;
    try {
      await onSend({
        text: submitted.trim(),
        attachmentIds: attachments.readyIds,
      });
      dispatch({ type: "sent", submitted });
      attachments.sent(files);
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

  /** Add pasted files, such as a screenshot, leaving pasted text to the field. */
  function paste(event: ClipboardEvent<HTMLTextAreaElement>): void {
    const pasted = [...event.clipboardData.files];
    if (!pasted.length || disabled) return;
    event.preventDefault();
    attachments.add(pasted);
  }

  return (
    <InputSurface
      as="form"
      className="chat-composer"
      data-dragging={dragging || undefined}
      onSubmit={(event) => void submit(event)}
      onDragOver={(event) => {
        if (disabled || !carriesFiles(event)) return;
        event.preventDefault();
        event.dataTransfer.dropEffect = "copy";
        setDragging(true);
      }}
      onDragLeave={(event) => {
        if (!event.currentTarget.contains(event.relatedTarget as Node | null))
          setDragging(false);
      }}
      onDrop={(event) => {
        if (disabled || !carriesFiles(event)) return;
        event.preventDefault();
        setDragging(false);
        attachments.add([...event.dataTransfer.files]);
      }}
    >
      {dictation.offered && <VoiceStatus voice={voice} />}
      <ComposerAttachments
        items={attachments.items}
        problems={attachments.problems}
        onRetry={attachments.retry}
        onRemove={attachments.remove}
        onDismissProblems={attachments.dismissProblems}
      />
      {/* Stays mounted, even when empty, so screen readers announce why sending waits. */}
      <p
        id="composer-attachment-status"
        className="chat-attachment-summary"
        role="status"
      >
        {attachmentStatus}
      </p>
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
            // The draft this change was typed against, which a dictation may have changed since.
            base: draft,
            composing: (event.nativeEvent as InputEvent).isComposing ?? false,
          })
        }
        onKeyDown={keyDown}
        onPaste={paste}
        onKeyUp={dictation.keyUp}
        onSelect={dictation.select}
        onBlur={dictation.blur}
        onCompositionStart={dictation.compositionStart}
        onCompositionEnd={dictation.compositionEnd}
        onPointerDown={dictation.interrupt}
        maxLength={messageTextMaxLength}
        disabled={disabled}
        placeholder={`Message ${name}…`}
        aria-describedby={
          dictation.offered
            ? `composer-help composer-attachment-status ${voiceStatusId}`
            : "composer-help composer-attachment-status"
        }
      />
      <div className="chat-composer-actions">
        <p id="composer-help">
          Enter to send · Shift+Enter for a new line
          {dictation.holdEnabled && (
            // The microphone button is the only visible voice control.
            <span className="sr-only">
              {" "}
              · Hold Space for 1 second to record
            </span>
          )}
        </p>
        <input
          ref={picker}
          type="file"
          multiple
          hidden
          tabIndex={-1}
          aria-hidden="true"
          onChange={(event) => {
            attachments.add([...(event.target.files ?? [])]);
            // Let the same file be chosen again after it is removed.
            event.target.value = "";
          }}
        />
        <IconButton
          label="Attach files"
          className="attach-button"
          disabled={disabled}
          onClick={() => picker.current?.click()}
        >
          <Paperclip aria-hidden="true" />
        </IconButton>
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
