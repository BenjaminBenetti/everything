import { Check, Palette } from "lucide-react";
import { Button } from "@everything/ui/button";
import { Dialog } from "@everything/ui/dialog";
import { ThemePicker } from "@everything/ui/theme";

/** One preferences surface shared by every signed-in avatar entry point. */
export function PreferencesDialog({ onClose }: { onClose: () => void }) {
  return (
    <Dialog
      title="Preferences"
      description="A little more you. Make this space your own."
      className="preferences-dialog"
      onClose={onClose}
      footer={
        <div className="preferences-footer">
          <span>
            <Check aria-hidden="true" />
            Saved on this device
          </span>
          <Button onClick={onClose}>Done</Button>
        </div>
      }
    >
      <div className="preferences-section-heading">
        <span className="preferences-section-icon">
          <Palette aria-hidden="true" />
        </span>
        <div>
          <h3>Appearance</h3>
          <p>Choose a color theme that feels right.</p>
        </div>
      </div>
      <ThemePicker />
    </Dialog>
  );
}
