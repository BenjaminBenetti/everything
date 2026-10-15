import { Button } from "@everything/ui/button";
import { Switch } from "@everything/ui/switch";
import {
  useGeneralSettings,
  useUpdateGeneralSettings,
} from "./workspace-settings-provider.js";

/** Save summary preferences with loading, retry, and failed-save feedback. */
export function GeneralSettingsControls() {
  const settings = useGeneralSettings();
  const update = useUpdateGeneralSettings();
  if (settings.isPending)
    return (
      <p className="settings-status" role="status">
        Loading general settings…
      </p>
    );
  if (settings.isError)
    return (
      <div className="settings-status" role="alert">
        <p>
          General settings aren’t available right now. Try again in a moment.
        </p>
        <Button variant="light" onClick={() => void settings.refetch()}>
          Try again
        </Button>
      </div>
    );
  const summarizeUpdates = update.isPending
    ? update.variables.summarizeUpdates
    : settings.data.summarizeUpdates;
  return (
    <>
      <Switch
        className="settings-switch"
        label="Summarize updates"
        description="Use AI to summarize teammate messages on update cards."
        checked={summarizeUpdates}
        disabled={update.isPending}
        onChange={(checked) => update.mutate({ summarizeUpdates: checked })}
      />
      {update.isError && (
        <p className="form-error" role="alert">
          Couldn’t change this setting. Try again.
        </p>
      )}
    </>
  );
}
