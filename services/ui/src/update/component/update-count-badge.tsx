/** Largest count shown in full; higher totals read "99+" so the badge stays compact. */
const maxShownCount = 99;

/** Compact unread total for navigation, hidden at zero; the link's label announces the exact count. */
export function UpdateCountBadge({ count }: { count: number }) {
  if (count <= 0) return null;
  return (
    <span className="update-count-badge" aria-hidden="true">
      {count > maxShownCount ? `${maxShownCount}+` : count}
    </span>
  );
}

/** Name a navigation link with its unread total, such as "Updates, 3 unread". */
export function unreadLinkLabel(
  label: string,
  count: number,
): string | undefined {
  return count > 0 ? `${label}, ${count} unread` : undefined;
}
