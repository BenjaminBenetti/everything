import { Button } from "@everything/ui/button";
import { Dialog } from "@everything/ui/dialog";

/** Explain installation accurately without requesting unusable push permissions. */
export function NotificationDialog({ onClose }: { onClose: () => void }) {
  return (
    <Dialog
      title="Stay in the loop."
      description="Keep Everything close, even when you’re away from your desk."
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
          <span>Sign in to find your team, right where you left it.</span>
        </li>
      </ol>
      <p className="availability-note">
        Push notifications aren’t available yet. You’ll be able to enable them
        here when they’re ready.
      </p>
      <div className="dialog-actions">
        <Button onClick={onClose}>Got it</Button>
      </div>
    </Dialog>
  );
}
