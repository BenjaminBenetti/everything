import { useLayoutEffect, useRef } from "react";
import type { ChatMessage } from "@everything/conversation-contracts";
import { Button } from "@everything/ui/button";

/** Display saved messages and preserve reading position when older history is prepended. */
export function MessageHistory({
  name,
  messages,
  hasOlder,
  loadingOlder,
  sentMessageId,
  onOlder,
}: {
  name: string;
  messages: readonly ChatMessage[];
  hasOlder: boolean;
  loadingOlder: boolean;
  sentMessageId: string | undefined;
  onOlder: () => Promise<unknown>;
}) {
  const viewport = useRef<HTMLDivElement>(null);
  const follow = useRef(true);
  const previousHeight = useRef<number | null>(null);
  const newestId = messages.at(-1)?.id;

  useLayoutEffect(() => {
    follow.current = true;
  }, [sentMessageId]);

  useLayoutEffect(() => {
    const element = viewport.current;
    if (!element) return;
    if (previousHeight.current !== null && !loadingOlder) {
      element.scrollTop = element.scrollHeight - previousHeight.current;
      previousHeight.current = null;
    } else if (follow.current) element.scrollTop = element.scrollHeight;
  }, [messages, loadingOlder, newestId, sentMessageId]);

  /** Anchor the reader's current position while fetching earlier messages. */
  async function loadOlder(): Promise<void> {
    const element = viewport.current;
    if (element)
      previousHeight.current = element.scrollHeight - element.scrollTop;
    follow.current = false;
    try {
      await onOlder();
    } catch {
      previousHeight.current = null;
    }
  }

  return (
    <div
      className="chat-history"
      ref={viewport}
      onScroll={(event) => {
        const element = event.currentTarget;
        follow.current =
          element.scrollHeight - element.scrollTop - element.clientHeight < 80;
      }}
    >
      {hasOlder && (
        <div className="chat-history-more">
          <Button
            variant="light"
            disabled={loadingOlder}
            onClick={() => void loadOlder()}
          >
            {loadingOlder
              ? "Loading earlier messages…"
              : "Load earlier messages"}
          </Button>
        </div>
      )}
      <div
        className="chat-messages"
        role="log"
        aria-label={`Conversation with ${name}`}
        aria-live="polite"
        aria-relevant="additions"
      >
        {messages.map((message) => (
          <article
            className={`chat-message ${message.role}`}
            key={message.id}
            aria-label={`${message.role === "user" ? "You" : name} said`}
          >
            <div className="chat-message-meta">
              <strong>{message.role === "user" ? "You" : name}</strong>
              <time
                dateTime={message.createdAt}
                title={new Date(message.createdAt).toLocaleString()}
              >
                {new Date(message.createdAt).toLocaleTimeString([], {
                  hour: "2-digit",
                  minute: "2-digit",
                })}
              </time>
            </div>
            <p>{message.text}</p>
          </article>
        ))}
      </div>
      {!messages.length && (
        <div className="chat-empty">
          <h2>Talk with {name}</h2>
          <p>Ask a question or share what you’re working on</p>
        </div>
      )}
    </div>
  );
}
