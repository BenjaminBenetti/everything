import type { MessagePage } from "@everything/conversation-contracts";

/** Merge live messages while retaining loaded history; a disjoint refresh resets pagination to avoid gaps. */
export function refreshHistory(
  current: MessagePage | undefined,
  latest: MessagePage,
): MessagePage {
  if (!current?.messages.length) return latest;
  const incoming = new Set(latest.messages.map((message) => message.id));
  if (!current.messages.some((message) => incoming.has(message.id)))
    return latest;
  return {
    messages: [
      ...current.messages.filter((message) => !incoming.has(message.id)),
      ...latest.messages,
    ],
    nextCursor: current.nextCursor,
  };
}

/** Prepend a historical page without duplicating messages fetched by a concurrent refresh. */
export function prependHistory(
  current: MessagePage,
  older: MessagePage,
): MessagePage {
  const existing = new Set(current.messages.map((message) => message.id));
  return {
    messages: [
      ...older.messages.filter((message) => !existing.has(message.id)),
      ...current.messages,
    ],
    nextCursor: older.nextCursor,
  };
}
