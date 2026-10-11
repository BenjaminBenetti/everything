import type { ReactNode } from "react";
import type { LucideIcon } from "lucide-react";

/** Calm empty states communicate absence of data without fabricating activity. */
export function EmptyState({
  icon: Icon,
  title,
  children,
}: {
  icon: LucideIcon;
  title: string;
  children: ReactNode;
}) {
  return (
    <div className="empty-state">
      <Icon aria-hidden="true" />
      <h2>{title}</h2>
      <div className="empty-copy">{children}</div>
    </div>
  );
}
