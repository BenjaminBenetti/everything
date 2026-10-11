import { Button } from "@everything/ui/button";
import { Dialog } from "@everything/ui/dialog";

/** Explain installation accurately without requesting unusable push permissions. */
export function NotificationDialog({ onClose }: { onClose: () => void }) {
  return (
    <Dialog
      title="Phone setup"
      description="Add Everything to your Home Screen for quick access."
      onClose={onClose}
    >
      <ol className="steps">
        <li>
          <span className="step-number">1</span>
          <span>
            On iPhone, open Everything in Safari. Tap Share, then{" "}
            <strong>Add to Home Screen</strong>.
          </span>
        </li>
        <li>
          <span className="step-number">2</span>
          <span>
            Choose <strong>Open as Web App</strong>, then Add. Open Everything
            from your Home Screen.
          </span>
        </li>
        <li>
          <span className="step-number">3</span>
          <span>Sign in to access your team.</span>
        </li>
      </ol>
      <p className="availability-note">
        Push notifications aren’t available yet.
      </p>
      <div className="dialog-actions">
        <Button onClick={onClose}>Got it</Button>
      </div>
    </Dialog>
  );
}
