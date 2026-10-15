import { useLayoutEffect, useRef } from "react";
import type { ChatMessage } from "@everything/conversation-contracts";
import { Button } from "@everything/ui/button";
import { MessageMarkdown } from "./message-markdown.js";
import { useMessageReads } from "../hook/use-message-reads.js";

/**
 * Render saved Markdown messages, with typing bubbles while the teammate writes a message, and
 * preserve reading position when older history is prepended.
 */
export function MessageHistory({
  agentId,
  name,
  targetMessageId,
  readEnabled,
  messages,
  hasOlder,
  loadingOlder,
  sentMessageId,
  typing,
  onOlder,
}: {
  agentId: string;
  name: string;
  targetMessageId: string | undefined;
  readEnabled: boolean;
  messages: readonly ChatMessage[];
  hasOlder: boolean;
  loadingOlder: boolean;
  sentMessageId: string | undefined;
  typing: boolean;
  onOlder: () => Promise<unknown>;
}) {
  const viewport = useRef<HTMLDivElement>(null);
  const follow = useRef(true);
  const previousHeight = useRef<number | null>(null);
  const newestId = messages.at(-1)?.id;
  const positionedTarget = useRef<string | undefined>(undefined);
  const readsFailed = useMessageReads(agentId, viewport, messages, readEnabled);

  useLayoutEffect(() => {
    follow.current = !targetMessageId;
    positionedTarget.current = undefined;
  }, [targetMessageId]);

  useLayoutEffect(() => {
    if (!targetMessageId) {
      if (positionedTarget.current) follow.current = true;
      positionedTarget.current = undefined;
      return;
    }
    const target = [
      ...(viewport.current?.querySelectorAll<HTMLElement>(
        "[data-message-id]",
      ) ?? []),
    ].find((element) => element.dataset.messageId === targetMessageId);
    if (!target) {
      positionedTarget.current = undefined;
      follow.current = false;
      return;
    }
    if (positionedTarget.current !== targetMessageId) {
      follow.current = false;
      previousHeight.current = null;
      const viewportHeight =
        viewport.current?.clientHeight ?? window.innerHeight;
      // Start long replies at their beginning instead of dropping the reader into the middle.
      target.scrollIntoView({
        block:
          target.getBoundingClientRect().height > viewportHeight
            ? "start"
            : "center",
      });
      positionedTarget.current = targetMessageId;
    }
  }, [messages, targetMessageId]);

  useLayoutEffect(() => {
    if (sentMessageId) follow.current = true;
  }, [sentMessageId]);

  useLayoutEffect(() => {
    const element = viewport.current;
    if (!element) return;
    if (previousHeight.current !== null && !loadingOlder) {
      element.scrollTop = element.scrollHeight - previousHeight.current;
      previousHeight.current = null;
    } else if (follow.current) element.scrollTop = element.scrollHeight;
  }, [
    messages,
    loadingOlder,
    newestId,
    sentMessageId,
    typing,
    targetMessageId,
  ]);

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
        onLoadCapture={() => {
          const element = viewport.current;
          if (element && follow.current)
            element.scrollTop = element.scrollHeight;
        }}
      >
        {messages.map((message) => (
          <article
            className={`chat-message ${message.role} ${message.id === targetMessageId ? "update-target" : ""}`}
            key={message.id}
            data-message-id={message.id}
            data-read-message={
              message.role === "assistant" ? message.id : undefined
            }
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
            <MessageMarkdown text={message.text} />
          </article>
        ))}
      </div>
      {/* The live region stays mounted so screen readers announce typing when it starts. */}
      <div className="chat-typing" role="status">
        {typing && (
          <>
            <span className="sr-only">{name} is typing</span>
            <span className="chat-typing-bubble" aria-hidden="true">
              <span />
              <span />
              <span />
            </span>
          </>
        )}
      </div>
      {!messages.length && (
        <div className="chat-empty">
          <h2>Talk with {name}</h2>
          <p>Ask a question or share what you’re working on</p>
        </div>
      )}
      {readsFailed && (
        <p role="status">
          Read status couldn’t be saved. Retrying when connected…
        </p>
      )}
    </div>
  );
}
