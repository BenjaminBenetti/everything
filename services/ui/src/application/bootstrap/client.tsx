import { StrictMode } from "react";
import { createRoot } from "react-dom/client";
import { BrowserRouter } from "react-router-dom";
import { QueryClient } from "@tanstack/react-query";
import { createBrowserSession } from "@everything/security/browser";
import { initializeTheme } from "@everything/ui/theme";
import { HttpAgentDirectory } from "../../agent/adapter/http-agent-directory.js";
import { HttpArtifactLibrary } from "../../artifact/adapter/http-artifact-library.js";
import { HttpProviderConnections } from "../../provider/adapter/http-provider-connections.js";
import { HttpWorkspaceSettings } from "../../settings/adapter/http-workspace-settings.js";
import { createAuthenticatedTransport } from "../../http/adapter/authenticated-transport.js";
import { Application } from "../component/application.js";
import { ApplicationErrorBoundary } from "../component/error-boundary.js";
import { AvatarAnimationRegistry } from "../../agent/service/avatar-animation-registry.js";
import { AvatarAnimationProvider } from "../../agent/component/avatar-animation.js";
import { IdleAvatarAnimation } from "../../agent/component/idle-avatar-animation.js";
import "../../workspace/style/application.css";
import "../../provider/style/provider.css";
import "../../conversation/style/conversation.css";
import "../../conversation/style/message-markdown.css";
import "../../update/style/updates.css";
import { HttpConversationClient } from "../../conversation/adapter/http-conversation-client.js";
import { HttpUpdateClient } from "../../update/adapter/http-update-client.js";

initializeTheme();
const element = document.getElementById("root");
if (!element) throw new Error("Application root is missing");
const root = createRoot(element);

/** Assemble same-origin browser capabilities independently of identity-provider configuration. */
async function bootstrap(): Promise<void> {
  const session = createBrowserSession();
  const directory = new HttpAgentDirectory(createAuthenticatedTransport());
  const avatarAnimations = new AvatarAnimationRegistry();
  avatarAnimations.register("idle", IdleAvatarAnimation);
  root.render(
    <StrictMode>
      <ApplicationErrorBoundary>
        <BrowserRouter>
          <AvatarAnimationProvider animations={avatarAnimations}>
            <Application
              session={session}
              directory={directory}
              artifacts={
                new HttpArtifactLibrary(createAuthenticatedTransport())
              }
              conversations={
                new HttpConversationClient(createAuthenticatedTransport())
              }
              updates={new HttpUpdateClient(createAuthenticatedTransport())}
              connections={
                new HttpProviderConnections(createAuthenticatedTransport())
              }
              settings={
                new HttpWorkspaceSettings(createAuthenticatedTransport())
              }
              queryClient={new QueryClient()}
            />
          </AvatarAnimationProvider>
        </BrowserRouter>
      </ApplicationErrorBoundary>
    </StrictMode>,
  );
  if ("serviceWorker" in navigator && import.meta.env.PROD) {
    // Installation is optional; workspace use must not depend on service-worker support.
    void navigator.serviceWorker.register("/sw.js").catch(() => undefined);
  }
}

bootstrap().catch(() =>
  root.render(
    <main className="startup-screen">
      <h1>Everything</h1>
      <p role="alert">
        Your workspace couldn’t connect. Check your connection and try again.
      </p>
      <button className="button primary" onClick={() => location.reload()}>
        Try again
      </button>
    </main>,
  ),
);
