import { useEffect, useRef, useState } from "react";
import { useQueryClient } from "@tanstack/react-query";
import {
  Bell,
  ChevronRight,
  Folder,
  Grid2X2,
  House,
  LogOut,
  Plus,
  Plug,
} from "lucide-react";
import { NavLink, Outlet, useLocation } from "react-router-dom";
import { Brand } from "@everything/ui/brand";
import { TeammateAvatar } from "../../agent/component/teammate-avatar.js";
import { IconButton } from "@everything/ui/button";
import { AvatarButton } from "@everything/ui/avatar";
import { useAgents } from "../../agent/component/agent-directory-provider.js";
import { useSession } from "../../session/component/session-provider.js";
import { useWorkspaceDialogs } from "./workspace-dialogs.js";
import { useProviders } from "../../provider/component/provider-connections-context.js";

const navigation = [
  { path: "/", label: "Home", icon: House },
  { path: "/team", label: "Your team", icon: Grid2X2 },
  { path: "/updates", label: "Updates", icon: Bell },
  { path: "/artifacts", label: "Artifacts", icon: Folder },
];

/** Keep workspace navigation stationary while route content changes and scrolls independently. */
export function WorkspaceShell() {
  const { profile, signOut: endSession } = useSession();
  const agents = useAgents();
  const providers = useProviders();
  const hasVerifiedProvider =
    !providers.isError &&
    providers.data?.some((provider) => provider.status === "verified");
  const { open } = useWorkspaceDialogs();
  const cache = useQueryClient();
  const { pathname } = useLocation();
  const content = useRef<HTMLElement>(null);
  const previousPath = useRef(pathname);
  const [signingOut, setSigningOut] = useState(false);
  const [error, setError] = useState("");
  const label =
    navigation.find((item) => item.path === pathname)?.label ??
    "Page not found";
  useEffect(() => {
    document.title = `${label} · Everything`;
    content.current?.scrollTo({ top: 0 });
    if (previousPath.current !== pathname) content.current?.focus();
    previousPath.current = pathname;
  }, [pathname, label]);
  /** Remove cached private data before returning to the welcome screen. */
  async function signOut(): Promise<void> {
    setSigningOut(true);
    await cache.cancelQueries();
    cache.clear();
    try {
      await endSession();
    } catch {
      setError("Sign-out couldn’t finish. Reload this page and try again.");
    }
  }
  if (signingOut)
    return (
      <main className="startup-screen">
        <Brand />
        <p role="status">{error || "Signing out…"}</p>
        {error && (
          <button className="button light" onClick={() => location.reload()}>
            Reload
          </button>
        )}
      </main>
    );
  return (
    <div className="shell">
      <a className="skip-link" href="#workspace-content">
        Skip to content
      </a>
      <aside className="sidebar">
        <Brand />
        <nav aria-label="Workspace">
          {navigation.map(({ path, label: itemLabel, icon: Icon }) => (
            <NavLink
              key={path}
              to={path}
              end
              className={({ isActive }) =>
                `nav-item ${isActive ? "active" : ""}`
              }
            >
              <Icon aria-hidden="true" />
              {itemLabel}
            </NavLink>
          ))}
        </nav>
        <div className="sidebar-section">
          <span className="eyebrow">Your team</span>
          <IconButton
            label="Create a new teammate"
            onClick={() => open({ kind: "editor" })}
          >
            <Plus aria-hidden="true" />
          </IconButton>
        </div>
        <div className="sidebar-agents">
          {agents.data?.map((agent) => (
            <button
              key={agent.id}
              className="side-agent"
              onClick={() => open({ kind: "details", agent })}
            >
              <TeammateAvatar avatarId={agent.avatarId} small />
              <span>{agent.name}</span>
            </button>
          ))}
          {agents.data?.length === 0 && (
            <p className="sidebar-empty">No teammates yet.</p>
          )}
          {agents.isError && (
            <p className="sidebar-empty">
              Your team couldn’t load. <NavLink to="/team">Try again</NavLink>
            </p>
          )}
        </div>
        <div className="sidebar-bottom">
          <div className="space-card">
            <span className="dot" />
            Your personal workspace
          </div>
          <div className="profile">
            <AvatarButton
              name={profile?.displayName ?? "You"}
              label="Open preferences"
              aria-haspopup="dialog"
              onClick={() => open({ kind: "preferences" })}
            />
            <span>
              {profile?.displayName}
              <small>Your account</small>
            </span>
            <IconButton label="Sign out" onClick={() => void signOut()}>
              <LogOut aria-hidden="true" />
            </IconButton>
          </div>
        </div>
      </aside>
      <div className="main">
        <header className="topbar">
          <Brand className="mobile-wordmark" />
          <div className="breadcrumb">
            Your workspace <ChevronRight aria-hidden="true" />
            <span>{label}</span>
          </div>
          <div className="topbar-right">
            <span className="topbar-caption">Your team, in one place.</span>
            <IconButton
              label={
                hasVerifiedProvider
                  ? "Model providers — connection verified"
                  : "Model providers — no verified connection"
              }
              className={`provider-button ${hasVerifiedProvider ? "connected" : ""}`}
              onClick={() => open({ kind: "provider" })}
            >
              <Plug aria-hidden="true" />
            </IconButton>
            <IconButton
              label="Notification settings"
              onClick={() => open({ kind: "notifications" })}
            >
              <Bell aria-hidden="true" />
            </IconButton>
            <IconButton label="Sign out" onClick={() => void signOut()}>
              <LogOut aria-hidden="true" />
            </IconButton>
            <AvatarButton
              className="mobile-profile"
              name={profile?.displayName ?? "You"}
              label="Open preferences"
              aria-haspopup="dialog"
              onClick={() => open({ kind: "preferences" })}
            />
          </div>
        </header>
        <main
          id="workspace-content"
          data-dialog-fallback=""
          ref={content}
          tabIndex={-1}
          className={`content ${pathname === "/" ? "dashboard-content" : ""}`}
        >
          <div key={pathname} className="route-content">
            <Outlet />
          </div>
        </main>
      </div>
      <nav className="mobile-nav" aria-label="Mobile workspace">
        {navigation.map(({ path, label: itemLabel, icon: Icon }) => (
          <NavLink
            key={path}
            to={path}
            end
            className={({ isActive }) => (isActive ? "active" : "")}
          >
            <Icon aria-hidden="true" />
            {itemLabel === "Your team" ? "Team" : itemLabel}
          </NavLink>
        ))}
      </nav>
    </div>
  );
}
