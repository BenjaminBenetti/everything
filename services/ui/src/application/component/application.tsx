import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { Navigate, Route, Routes } from "react-router-dom";
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

/** Application composition accepts capabilities, making real and test transports interchangeable. */
export function Application({
  session,
  directory,
  artifacts,
  connections,
  conversations,
  updates,
  settings,
  queryClient,
}: {
  session: BrowserSession;
  directory: AgentDirectory;
  artifacts: ArtifactLibrary;
  connections: ProviderConnections;
  conversations: ConversationClient;
  updates: UpdateClient;
  settings: WorkspaceSettings;
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
                    <AuthenticatedRoutes />
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
function AuthenticatedRoutes() {
  const { profile, loading } = useSession();
  if (loading)
    return (
      <main className="startup-screen">
        <Brand />
        <p role="status">Opening your workspace…</p>
      </main>
    );
  if (!profile) return <LoginPage />;
  return (
    <WorkspaceDialogsProvider>
      <Routes>
        <Route path="artifacts/open" element={<ArtifactOpenPage />} />
        <Route element={<WorkspaceShell />}>
          <Route index element={<HomePage />} />
          <Route path="team" element={<TeamPage />} />
          <Route path="team/:agentId" element={<ConversationPage />} />
          <Route path="updates" element={<UpdatesPage />} />
          <Route path="artifacts" element={<ArtifactsPage />} />
          <Route path="login" element={<Navigate replace to="/" />} />
          <Route path="*" element={<Navigate replace to="/" />} />
        </Route>
      </Routes>
    </WorkspaceDialogsProvider>
  );
}
