import type { KeyDirectory } from "../../key/interface/key-directory.js";
import { KeyDirectoryProvider } from "../../key/component/key-directory-provider.js";
import { KeysPage } from "../../key/page/keys-page.js";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { Navigate, Route, Routes, useLocation } from "react-router-dom";
import type { BrowserSession } from "@everything/security/browser";
import { Brand } from "@everything/ui/brand";
import type { AgentDirectory } from "../../agent/interface/agent-directory.js";
import { AgentDirectoryProvider } from "../../agent/component/agent-directory-provider.js";
import { TeamPage } from "../../agent/page/team-page.js";
import type { ArtifactLibrary } from "../../artifact/interface/artifact-library.js";
import { ArtifactLibraryProvider } from "../../artifact/component/artifact-library-provider.js";
import { ArtifactOpenPage } from "../../artifact/page/artifact-open-page.js";
import { ArtifactsPage } from "../../artifact/page/artifacts-page.js";
import { HomePage } from "../../dashboard/page/home-page.js";
import {
  SessionProvider,
  useSession,
} from "../../session/component/session-provider.js";
import { LoginPage } from "../../session/page/login-page.js";
import type { UpdateClient } from "../../update/interface/update-client.js";
import { UpdateProvider } from "../../update/component/update-provider.js";
import { UpdatesPage } from "../../update/page/updates-page.js";
import { WorkspaceDialogsProvider } from "../../workspace/component/workspace-dialogs.js";
import { WorkspaceShell } from "../../workspace/component/workspace-shell.js";
import type { ProviderConnections } from "../../provider/interface/provider-connections.js";
import { ProviderConnectionsProvider } from "../../provider/component/provider-connections-context.js";
import type { ConversationClient } from "../../conversation/interface/conversation-client.js";
import { ConversationProvider } from "../../conversation/component/conversation-provider.js";
import { ConversationPage } from "../../conversation/page/conversation-page.js";
import type { WorkspaceSettings } from "../../settings/interface/workspace-settings.js";
import { WorkspaceSettingsProvider } from "../../settings/component/workspace-settings-provider.js";
import type { InstallationUpgrades } from "../../upgrade/interface/installation-upgrades.js";
import { InstallationUpgradesProvider } from "../../upgrade/component/installation-upgrades-provider.js";
import type { DesktopNotifications } from "../../notification/interface/desktop-notifications.js";
import { DesktopNotificationProvider } from "../../notification/component/desktop-notification-provider.js";
import { DeliveryNotifications } from "../../notification/component/delivery-notifications.js";
import type { WorkspaceDirectory } from "../../workspace/interface/workspace-directory.js";
import { WorkspaceDirectoryProvider } from "../../workspace/component/workspace-directory-provider.js";
import { WorkspacesPage } from "../../workspace/page/workspaces-page.js";
import type { VoiceClient } from "../../voice/interface/voice-client.js";
import type { MediaEnvironment } from "../../voice/interface/media-environment.js";
import type { PcmCaptureEnvironment } from "../../voice/interface/pcm-capture.js";
import { VoiceProvider } from "../../voice/component/voice-provider.js";

/** Application composition accepts capabilities, making real and test transports interchangeable. */
export function Application({
  session,
  directory,
  artifacts,
  connections,
  conversations,
  updates,
  settings,
  upgrades,
  workspaces,
  keys,
  notifications,
  voice,
  media,
  capture,
  queryClient,
}: {
  session: BrowserSession;
  directory: AgentDirectory;
  artifacts: ArtifactLibrary;
  connections: ProviderConnections;
  conversations: ConversationClient;
  updates: UpdateClient;
  settings: WorkspaceSettings;
  upgrades: InstallationUpgrades;
  workspaces: WorkspaceDirectory;
  keys: KeyDirectory;
  notifications: DesktopNotifications;
  voice: VoiceClient;
  media: MediaEnvironment;
  capture: PcmCaptureEnvironment;
  queryClient: QueryClient;
}) {
  return (
    <QueryClientProvider client={queryClient}>
      <SessionProvider session={session}>
        <AgentDirectoryProvider directory={directory}>
          <ArtifactLibraryProvider library={artifacts}>
            <ProviderConnectionsProvider connections={connections}>
              <ConversationProvider client={conversations}>
                <UpdateProvider client={updates}>
                  <WorkspaceSettingsProvider settings={settings}>
                    <InstallationUpgradesProvider upgrades={upgrades}>
                      <WorkspaceDirectoryProvider directory={workspaces}>
                        <KeyDirectoryProvider directory={keys}>
                          <VoiceProvider
                            client={voice}
                            media={media}
                            capture={capture}
                          >
                            <AuthenticatedRoutes
                              notifications={notifications}
                            />
                          </VoiceProvider>
                        </KeyDirectoryProvider>
                      </WorkspaceDirectoryProvider>
                    </InstallationUpgradesProvider>
                  </WorkspaceSettingsProvider>
                </UpdateProvider>
              </ConversationProvider>
            </ProviderConnectionsProvider>
          </ArtifactLibraryProvider>
        </AgentDirectoryProvider>
      </SessionProvider>
    </QueryClientProvider>
  );
}

/** Mount private pages only after session restoration, retaining the current route. */
function AuthenticatedRoutes({
  notifications,
}: {
  notifications: DesktopNotifications;
}) {
  const { profile, loading } = useSession();
  const { search, hash } = useLocation();
  if (loading)
    return (
      <main className="startup-screen">
        <Brand />
        <p role="status">Opening your workspace…</p>
      </main>
    );
  if (!profile) return <LoginPage />;
  return (
    // Each signed-in user gets their own notification state, so nothing carries over to another account.
    <DesktopNotificationProvider
      key={profile.subject}
      notifications={notifications}
    >
      <WorkspaceDialogsProvider>
        <DeliveryNotifications />
        <Routes>
          <Route path="apps/open" element={<ArtifactOpenPage />} />
          <Route
            path="artifacts/open"
            element={
              <Navigate replace to={{ pathname: "/apps/open", search, hash }} />
            }
          />
          <Route element={<WorkspaceShell />}>
            <Route index element={<HomePage />} />
            <Route path="team" element={<TeamPage />} />
            <Route path="team/:agentId" element={<ConversationPage />} />
            <Route path="updates" element={<UpdatesPage />} />
            <Route path="apps" element={<ArtifactsPage />} />
            <Route
              path="artifacts"
              element={
                <Navigate replace to={{ pathname: "/apps", search, hash }} />
              }
            />
            <Route path="keys" element={<KeysPage />} />
            <Route path="workspaces" element={<WorkspacesPage />} />
            <Route path="login" element={<Navigate replace to="/" />} />
            <Route path="*" element={<Navigate replace to="/" />} />
          </Route>
        </Routes>
      </WorkspaceDialogsProvider>
    </DesktopNotificationProvider>
  );
}
