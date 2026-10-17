import * as Primitive from "@radix-ui/react-dropdown-menu";
import { useRef, type ReactNode } from "react";

/** A named action displayed in a themed menu. */
export interface MenuAction {
  readonly label: string;
  readonly icon: ReactNode;
  readonly description?: string;
  /** Run after dismissal so dialogs can restore focus to the menu trigger. */
  readonly onSelect: () => void;
}

/** Offer keyboard and touch actions, restoring trigger focus before opening another surface. */
export function ActionMenu({
  label,
  icon,
  actions,
}: {
  label: string;
  icon: ReactNode;
  actions: readonly MenuAction[];
}) {
  const trigger = useRef<HTMLButtonElement>(null);
  const pending = useRef<(() => void) | undefined>(undefined);
  return (
    <Primitive.Root>
      <Primitive.Trigger
        ref={trigger}
        className="icon-button action-menu-trigger"
        aria-label={label}
        title={label}
      >
        {icon}
      </Primitive.Trigger>
      <Primitive.Portal>
        <Primitive.Content
          className="action-menu-content"
          aria-label={label}
          align="end"
          sideOffset={8}
          collisionPadding={12}
          onCloseAutoFocus={(event) => {
            const action = pending.current;
            pending.current = undefined;
            if (!action) return;
            event.preventDefault();
            trigger.current?.focus();
            action();
          }}
        >
          {actions.map((action) => (
            <Primitive.Item
              key={action.label}
              className="action-menu-item"
              textValue={action.label}
              onSelect={() => {
                pending.current = action.onSelect;
              }}
            >
              <span className="action-menu-icon" aria-hidden="true">
                {action.icon}
              </span>
              <span>
                {action.label}
                {action.description && <small>{action.description}</small>}
              </span>
            </Primitive.Item>
          ))}
        </Primitive.Content>
      </Primitive.Portal>
    </Primitive.Root>
  );
}
