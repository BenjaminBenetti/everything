import * as Primitive from "@radix-ui/react-dialog";
import { X } from "lucide-react";
import type { ReactNode } from "react";
import { IconButton } from "../../control/component/button.js";

/** Accessible modal with guarded dismissal, focus restoration, and optional fixed footer actions. */
export function Dialog({
  title,
  description,
  children,
  footer,
  onClose,
  className = "",
  role = "dialog",
  dismissible = true,
}: {
  className?: string;
  title: string;
  description: string;
  children: ReactNode;
  footer?: ReactNode;
  onClose: () => void;
  role?: "dialog" | "alertdialog";
  dismissible?: boolean;
}) {
  return (
    <Primitive.Root
      open
      onOpenChange={(open) => {
        if (!open && dismissible) onClose();
      }}
    >
      <Primitive.Portal>
        <Primitive.Overlay className="dialog-overlay" />
        <Primitive.Content
          role={role}
          className={`dialog-content ${footer ? "dialog-with-footer" : ""} ${className}`}
          onEscapeKeyDown={(event) => {
            if (!dismissible) event.preventDefault();
          }}
          onPointerDownOutside={(event) => {
            if (!dismissible || role === "alertdialog") event.preventDefault();
          }}
          onCloseAutoFocus={(event) => {
            // These dialogs are opened from several controls, without a Radix Trigger.
            event.preventDefault();
            // Modal transitions retain the original opener until the final surface closes.
            if (
              document.querySelector(
                '[role="dialog"][data-state="open"], [role="alertdialog"][data-state="open"]',
              )
            )
              return;
            const target = document.querySelector<HTMLElement>(
              "[data-dialog-return]",
            );
            // Deleting an item can remove its opener; the host declares a stable fallback.
            const fallback = document.querySelector<HTMLElement>(
              "[data-dialog-fallback]",
            );
            (target ?? fallback)?.focus();
            target?.removeAttribute("data-dialog-return");
          }}
        >
          <div className="dialog-head">
            <Primitive.Title>{title}</Primitive.Title>
            <Primitive.Close asChild>
              <IconButton label="Close dialog" disabled={!dismissible}>
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
