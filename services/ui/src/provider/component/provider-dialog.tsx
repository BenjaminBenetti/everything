import { Button } from "@everything/ui/button";
import { Dialog } from "@everything/ui/dialog";

/** Describe the planned connection without fabricating OAuth or account state. */
export function ProviderDialog({ onClose }: { onClose: () => void }) {
  return (
    <Dialog
      title="Model providers"
      description="Your teammates will use a connected AI provider."
      onClose={onClose}
    >
      <div className="provider-card">
        <span className="chatgpt-logo" aria-hidden="true" />
        <div>
          <h3>ChatGPT</h3>
          <p>ChatGPT account connection</p>
        </div>
        <span className="availability-badge">Not available yet</span>
      </div>
      <p className="availability-note">
        Provider connections will be available with conversations. No account is
        connected through this app yet.
      </p>
      <div className="dialog-actions">
        <Button onClick={onClose}>Got it</Button>
      </div>
    </Dialog>
  );
}
