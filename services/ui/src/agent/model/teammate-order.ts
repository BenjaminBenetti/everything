/** Anything listed by teammate ID, such as an agent definition. */
interface Identified {
  readonly id: string;
}

/**
 * Arrange teammates in the owner's saved order. Saved IDs that no longer match a teammate and
 * repeated IDs are skipped; teammates the order doesn't list, such as new ones, follow in the
 * order supplied, which is creation order.
 */
export function arrangeTeammates<T extends Identified>(
  teammates: readonly T[],
  savedIds: readonly string[],
): T[] {
  const byId = new Map(teammates.map((teammate) => [teammate.id, teammate]));
  const arranged: T[] = [];
  for (const id of savedIds) {
    const teammate = byId.get(id);
    if (!teammate) continue;
    arranged.push(teammate);
    byId.delete(id);
  }
  return [...arranged, ...byId.values()];
}

/**
 * Move one teammate into another's place within the complete order, which may include
 * teammates a filtered view hides; everyone else keeps their relative order. Returns
 * `undefined` when nothing would change.
 */
export function moveTeammate(
  order: readonly string[],
  movedId: string,
  targetId: string,
): string[] | undefined {
  const from = order.indexOf(movedId);
  const to = order.indexOf(targetId);
  if (from < 0 || to < 0 || from === to) return undefined;
  const next = order.filter((id) => id !== movedId);
  next.splice(to, 0, movedId);
  return next;
}
