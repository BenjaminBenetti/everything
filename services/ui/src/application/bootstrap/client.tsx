import { StrictMode } from "react";
import { createRoot } from "react-dom/client";
import { BrowserRouter } from "react-router-dom";
import { QueryClient } from "@tanstack/react-query";
import { createBrowserSession } from "@everything/security/browser";
import { initializeTheme } from "@everything/ui/theme";
import { HttpAgentDirectory } from "../../agent/adapter/http-agent-directory.js";
import { createAuthenticatedTransport } from "../../http/adapter/authenticated-transport.js";
import { Application } from "../component/application.js";
import { ApplicationErrorBoundary } from "../component/error-boundary.js";
import "../../workspace/style/application.css";

initializeTheme();
const element = document.getElementById("root");
if (!element) throw new Error("Application root is missing");
const root = createRoot(element);

/** Assemble same-origin browser capabilities independently of identity-provider configuration. */
async function bootstrap(): Promise<void> {
  const session = createBrowserSession();
  const directory = new HttpAgentDirectory(createAuthenticatedTransport());
  root.render(
    <StrictMode>
      <ApplicationErrorBoundary>
        <BrowserRouter>
          <Application
            session={session}
            directory={directory}
            queryClient={new QueryClient()}
          />
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
