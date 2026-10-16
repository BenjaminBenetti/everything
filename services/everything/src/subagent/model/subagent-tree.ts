import type { Subagent } from "@everything/agent-contracts/subagent";
import { SubagentNotFoundError } from "../error/subagent-errors.js";

/** Resolve a known session's subtree without following untrusted filesystem paths or parent cycles. */
export function subagentDescendants(
  sessions: readonly Subagent[],
  id: string,
): string[] {
  if (!sessions.some((session) => session.id === id))
    throw new SubagentNotFoundError();
  const selected = new Set([id]);
  let previousSize = 0;
  while (selected.size !== previousSize) {
    previousSize = selected.size;
    for (const session of sessions) {
      if (selected.has(session.parentId)) selected.add(session.id);
    }
  }
  return [...selected];
}
