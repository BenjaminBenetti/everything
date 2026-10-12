import { useState, type FormEvent, type KeyboardEvent } from "react";
import { ArrowUp } from "lucide-react";
import { Button } from "@everything/ui/button";
import { messageTextMaxLength } from "@everything/conversation-contracts";

/** Keep the draft on failure and expose sending as an explicit action. */
export function MessageComposer({
  name,
  disabled,
  sending,
  onSend,
}: {
  name: string;
  disabled: boolean;
  sending: boolean;
  onSend: (text: string) => Promise<unknown>;
}) {
  const [draft, setDraft] = useState("");
  const canSend = !!draft.trim() && !disabled && !sending;

  /** Clear only the submitted draft after persistence succeeds, retaining text typed during the request. */
  async function submit(event: FormEvent<HTMLFormElement>): Promise<void> {
    event.preventDefault();
    if (!canSend) return;
    const submitted = draft;
    try {
      await onSend(submitted.trim());
      setDraft((current) => (current === submitted ? "" : current));
    } catch {
      // The conversation controller presents the failed request; the draft remains editable.
    }
  }

  /** Enter sends, Shift+Enter inserts a line, and IME composition never submits. */
  function keyDown(event: KeyboardEvent<HTMLTextAreaElement>): void {
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
    <form className="chat-composer" onSubmit={(event) => void submit(event)}>
      <label className="sr-only" htmlFor="chat-message">
        Message {name}
      </label>
      <textarea
        id="chat-message"
        rows={3}
        value={draft}
        onChange={(event) => setDraft(event.target.value)}
        onKeyDown={keyDown}
        maxLength={messageTextMaxLength}
        disabled={disabled}
        placeholder={`Message ${name}…`}
        aria-describedby="composer-help"
      />
      <div className="chat-composer-actions">
        <p id="composer-help">Enter to send · Shift+Enter for a new line</p>
        <Button type="submit" disabled={!canSend} aria-label="Send message">
          <ArrowUp aria-hidden="true" />
          <span>{sending ? "Sending…" : "Send"}</span>
        </Button>
      </div>
    </form>
  );
}
