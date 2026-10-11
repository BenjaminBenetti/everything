import { Button } from "@everything/ui/button";
import { Dialog } from "@everything/ui/dialog";

/** Describe the planned connection without fabricating OAuth or account state. */
export function ProviderDialog({ onClose }: { onClose: () => void }) {
  return (
    <Dialog
      title="Power your agents."
      description="Connect a model provider to give your agents a place to think."
      onClose={onClose}
    >
      <div className="provider-card">
        <span className="chatgpt-logo" aria-hidden="true" />
        <div>
          <h3>ChatGPT</h3>
          <p>Use your ChatGPT account.</p>
        </div>
        <span className="availability-badge">Coming soon</span>
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
