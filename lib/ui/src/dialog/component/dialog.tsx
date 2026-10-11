import * as Primitive from "@radix-ui/react-dialog";
import { X } from "lucide-react";
import type { ReactNode } from "react";
import { IconButton } from "../../control/component/button.js";

/** Accessible modal with focus trapping, Escape dismissal, and focus restoration. */
export function Dialog({
  title,
  description,
  children,
  footer,
  onClose,
  className = "",
}: {
  className?: string;
  title: string;
  description: string;
  children: ReactNode;
  footer?: ReactNode;
  onClose: () => void;
}) {
  return (
    <Primitive.Root
      open
      onOpenChange={(open) => {
        if (!open) onClose();
      }}
    >
      <Primitive.Portal>
        <Primitive.Overlay className="dialog-overlay" />
        <Primitive.Content
          className={`dialog-content ${className}`}
          onCloseAutoFocus={(event) => {
            // These dialogs are opened from several controls, without a Radix Trigger.
            event.preventDefault();
            const target = document.querySelector<HTMLElement>(
              "[data-dialog-return]",
            );
            target?.focus();
            target?.removeAttribute("data-dialog-return");
          }}
        >
          <div className="dialog-head">
            <Primitive.Title>{title}</Primitive.Title>
            <Primitive.Close asChild>
              <IconButton label="Close dialog">
                <X aria-hidden="true" />
              </IconButton>
            </Primitive.Close>
          </div>
          <Primitive.Description className="dialog-copy">
            {description}
          </Primitive.Description>
          <div className="dialog-body">{children}</div>
          {footer && <div className="dialog-footer">{footer}</div>}
        </Primitive.Content>
      </Primitive.Portal>
    </Primitive.Root>
  );
}
