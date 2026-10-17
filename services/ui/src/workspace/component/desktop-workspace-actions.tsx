import { Bell, LogOut, Plug, Settings } from "lucide-react";
import { IconButton } from "@everything/ui/button";
import { useProviders } from "../../provider/component/provider-connections-context.js";
import { useWorkspaceDialogs } from "./workspace-dialogs.js";

/** Keep desktop workspace actions directly available beside the breadcrumb. */
export function DesktopWorkspaceActions({
  onSignOut,
}: {
  onSignOut: () => void;
}) {
  const { open } = useWorkspaceDialogs();
  const providers = useProviders();
  const connected =
    !providers.isError &&
    providers.data?.some((provider) => provider.status === "verified");
  return (
    <div className="desktop-workspace-actions">
      <span className="topbar-caption">Your team, in one place.</span>
      <IconButton
        label={
          connected
            ? "Model providers — connection verified"
            : "Model providers — no verified connection"
        }
        className={`provider-button ${connected ? "connected" : ""}`}
        onClick={() => open({ kind: "provider" })}
      >
        <Plug aria-hidden="true" />
      </IconButton>
      <IconButton
        label="Notification settings"
        className="notification-button"
        onClick={() => open({ kind: "notifications" })}
      >
        <Bell aria-hidden="true" />
      </IconButton>
      <IconButton
        label="Settings"
        className="settings-button"
        onClick={() => open({ kind: "settings" })}
      >
        <Settings aria-hidden="true" />
      </IconButton>
      <IconButton
        label="Sign out"
        className="signout-button"
        onClick={onSignOut}
      >
        <LogOut aria-hidden="true" />
      </IconButton>
    </div>
  );
}
