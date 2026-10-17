import { useEffect, useRef, useState, type RefObject } from "react";
import { useQueryClient } from "@tanstack/react-query";
import {
  readReceiptMaxSize,
  type ChatMessage,
} from "@everything/conversation-contracts";
import { updateQueryRoot } from "../../update/hook/use-updates.js";
import { useConversationClient } from "../component/conversation-provider.js";

/** Receive new replies in the open chat; older history still requires sustained viewport exposure. */
export function useMessageReads(
  agentId: string,
  viewport: RefObject<HTMLDivElement | null>,
  messages: readonly ChatMessage[],
  latestMessages: readonly ChatMessage[] | undefined,
  enabled: boolean,
) {
  const client = useConversationClient();
  const cache = useQueryClient();
  const acknowledged = useRef(new Set<string>());
  const inFlight = useRef(new Set<string>());
  const retryAt = useRef(0);
  const previousLatest = useRef<Set<string> | undefined>(undefined);
  const incoming = useRef(new Set<string>());
  const [failed, setFailed] = useState(false);

  useEffect(() => {
    if (!latestMessages) return;
    // Only live snapshots discover arrivals. Loading older pages must not acknowledge unseen history.
    if (previousLatest.current) {
      for (const message of latestMessages) {
        if (
          message.role === "assistant" &&
          !previousLatest.current.has(message.id)
        )
          incoming.current.add(message.id);
      }
    }
    previousLatest.current = new Set(
      latestMessages.map((message) => message.id),
    );
  }, [latestMessages]);

  useEffect(() => {
    const root = viewport.current;
    if (!root) return;
    let stopped = false;
    const candidates = new Set<HTMLElement>();
    const exposedSince = new Map<string, number>();
    const observer = new IntersectionObserver(
      (entries) => {
        for (const entry of entries) {
          const element = entry.target as HTMLElement;
          if (entry.isIntersecting) candidates.add(element);
          else {
            candidates.delete(element);
            exposedSince.delete(element.dataset.readMessage!);
          }
        }
      },
      { root },
    );
    root
      .querySelectorAll<HTMLElement>("[data-read-message]")
      .forEach((element) => observer.observe(element));

    /** Reset the dwell time when attention leaves, even if it returns between timer ticks. */
    const resetExposure = () => exposedSince.clear();
    window.addEventListener("blur", resetExposure);
    document.addEventListener("visibilitychange", resetExposure);

    /** Require attention and exposure only for messages that predate opening this chat. */
    const exposedMessages = (): string[] => {
      if (
        !enabled ||
        document.visibilityState !== "visible" ||
        !document.hasFocus() ||
        document.querySelector('[role="dialog"]')
      ) {
        resetExposure();
        return [];
      }
      const now = Date.now();
      const bounds = root.getBoundingClientRect();
      const top = Math.max(0, bounds.top);
      const bottom = Math.min(window.innerHeight, bounds.bottom);
      const viewportHeight = bottom - top;
      const ready: string[] = [];
      for (const element of candidates) {
        const id = element.dataset.readMessage!;
        if (acknowledged.current.has(id) || inFlight.current.has(id)) continue;
        const rect = element.getBoundingClientRect();
        const visible = Math.min(bottom, rect.bottom) - Math.max(top, rect.top);
        // A long reply counts once its beginning or end is in view, including automatic
        // bottom-following; seeing only its middle is insufficient.
        const middleOnly =
          rect.height > viewportHeight &&
          rect.top < top - 1 &&
          rect.bottom > bottom + 1;
        if (
          viewportHeight <= 0 ||
          middleOnly ||
          visible < Math.min(rect.height, viewportHeight) / 2
        ) {
          exposedSince.delete(id);
          continue;
        }
        const since = exposedSince.get(id);
        if (since === undefined) exposedSince.set(id, now);
        else if (now - since >= 750) ready.push(id);
      }
      return ready;
    };

    /** Persist exact receipts for live replies and exposed history, retrying failures without losing arrivals. */
    function acknowledge(): void {
      if (stopped || Date.now() < retryAt.current) return;
      const ready = new Set([...incoming.current, ...exposedMessages()]);
      const ids = [...ready]
        .filter(
          (id) => !acknowledged.current.has(id) && !inFlight.current.has(id),
        )
        .slice(0, readReceiptMaxSize);
      if (!ids.length) return;
      ids.forEach((id) => inFlight.current.add(id));
      void client
        .read(agentId, ids)
        .then(() => {
          ids.forEach((id) => {
            acknowledged.current.add(id);
            incoming.current.delete(id);
          });
          if (!stopped) setFailed(false);
          // Refresh the feed and the navigation badge together.
          void cache.invalidateQueries({ queryKey: updateQueryRoot });
        })
        .catch(() => {
          retryAt.current = Date.now() + 5_000;
          if (!stopped) setFailed(true);
        })
        .finally(() => ids.forEach((id) => inFlight.current.delete(id)));
    }
    acknowledge();
    const timer = window.setInterval(acknowledge, 250);
    return () => {
      stopped = true;
      window.clearInterval(timer);
      observer.disconnect();
      window.removeEventListener("blur", resetExposure);
      document.removeEventListener("visibilitychange", resetExposure);
    };
  }, [agentId, cache, client, enabled, messages, latestMessages, viewport]);
  return failed;
}
