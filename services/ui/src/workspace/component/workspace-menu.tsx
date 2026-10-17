import { Bell, LogOut, Menu, Plug, Settings, UserRound } from "lucide-react";
import { ActionMenu } from "@everything/ui/action-menu";
import { useProviders } from "../../provider/component/provider-connections-context.js";
import { useWorkspaceDialogs } from "./workspace-dialogs.js";

/** Keep workspace and account actions together without crowding the navigation bar. */
export function WorkspaceMenu({ onSignOut }: { onSignOut: () => void }) {
  const { open } = useWorkspaceDialogs();
  const providers = useProviders();
  const connected = providers.data?.some(
    (provider) => provider.status === "verified",
  );
  const providerStatus = providers.isPending
    ? "Checking connection…"
    : providers.isError
      ? "Connection status unavailable"
      : connected
        ? "Connection verified"
        : "No verified connection";
  return (
    <ActionMenu
      label="Workspace menu"
      icon={<Menu aria-hidden="true" />}
      actions={[
        {
          label: "Model providers",
          description: providerStatus,
          icon: <Plug />,
          onSelect: () => open({ kind: "provider" }),
        },
        {
          label: "Notification settings",
          icon: <Bell />,
          onSelect: () => open({ kind: "notifications" }),
        },
        {
          label: "Settings",
          icon: <Settings />,
          onSelect: () => open({ kind: "settings" }),
        },
        {
          label: "Preferences",
          icon: <UserRound />,
          onSelect: () => open({ kind: "preferences" }),
        },
        { label: "Sign out", icon: <LogOut />, onSelect: onSignOut },
      ]}
    />
  );
}
