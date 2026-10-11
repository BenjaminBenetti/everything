import { Button } from "../../control/component/button.js";
import { Dialog } from "./dialog.js";

/** Confirm a destructive action with safe initial focus, guarded dismissal, and retry feedback. */
export function ConfirmationDialog({
  title,
  description,
  confirmLabel,
  pendingLabel,
  pending = false,
  error,
  onCancel,
  onConfirm,
}: {
  title: string;
  description: string;
  confirmLabel: string;
  pendingLabel: string;
  pending?: boolean;
  error?: string;
  onCancel: () => void;
  onConfirm: () => void;
}) {
  return (
    <Dialog
      role="alertdialog"
      title={title}
      description={description}
      onClose={onCancel}
      dismissible={!pending}
      footer={
        <div className="dialog-actions confirmation-actions">
          <Button
            autoFocus
            variant="light"
            disabled={pending}
            onClick={onCancel}
          >
            Cancel
          </Button>
          <Button variant="danger" disabled={pending} onClick={onConfirm}>
            {pending ? pendingLabel : confirmLabel}
          </Button>
        </div>
      }
    >
      <div aria-busy={pending}>
        {error && (
          <p className="form-error" role="alert">
            {error}
          </p>
        )}
      </div>
    </Dialog>
  );
}
