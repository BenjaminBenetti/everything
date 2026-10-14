import { Container, Globe } from "lucide-react";
import { Button } from "@everything/ui/button";
import { Dialog } from "@everything/ui/dialog";
import { Switch } from "@everything/ui/switch";
import {
  useUpdateWorkerSettings,
  useWorkerSettings,
} from "./workspace-settings-provider.js";

/** Settings that apply to the whole workspace, wherever the user signs in. */
export function SettingsDialog({ onClose }: { onClose: () => void }) {
  return (
    <Dialog
      title="Settings"
      description="Choose how your workspace runs. Changes apply everywhere you sign in."
      className="settings-dialog"
      onClose={onClose}
      footer={
        <div className="settings-footer">
          <span>
            <Globe aria-hidden="true" />
            Saved for your whole workspace
          </span>
          <Button onClick={onClose}>Done</Button>
        </div>
      }
    >
      <div className="settings-section-heading">
        <span className="settings-section-icon">
          <Container aria-hidden="true" />
        </span>
        <div>
          <h3>Workers</h3>
          <p>Isolated environments where teammates run larger jobs.</p>
        </div>
      </div>
      <WorkerSettingsControls />
    </Dialog>
  );
}

/** The worker switches, which follow the server's settings and show the change being saved. */
function WorkerSettingsControls() {
  const settings = useWorkerSettings();
  const update = useUpdateWorkerSettings();
  if (settings.isPending)
    return (
      <p className="settings-status" role="status">
        Loading worker settings…
      </p>
    );
  if (settings.isError)
    return (
      <div className="settings-status" role="alert">
        <p>
          Worker settings aren’t available right now. They’re ready once workers
          have started, so try again in a moment.
        </p>
        <Button variant="light" onClick={() => void settings.refetch()}>
          Try again
        </Button>
      </div>
    );
  const privileged = update.isPending
    ? update.variables.privileged
    : settings.data.privileged;
  return (
    <>
      <Switch
        className="settings-switch"
        label="Privileged workers"
        description="Enables Docker support."
        checked={privileged}
        disabled={update.isPending}
        onChange={(checked) => update.mutate({ privileged: checked })}
      />
      {update.isError && (
        <p className="form-error" role="alert">
          Couldn’t change this setting. Try again.
        </p>
      )}
    </>
  );
}
