import { useEffect, useRef, useState, type CSSProperties } from "react";
import { useQueryClient } from "@tanstack/react-query";
import {
  ArrowLeft,
  Bell,
  Boxes,
  ChevronRight,
  Folder,
  Grid2X2,
  House,
  KeyRound,
  LogOut,
  Plus,
} from "lucide-react";
import { Link, NavLink, Outlet, useLocation } from "react-router-dom";
import { Brand } from "@everything/ui/brand";
import { IconButton } from "@everything/ui/button";
import { AvatarButton } from "@everything/ui/avatar";
import { useAgents } from "../../agent/component/agent-directory-provider.js";
import { useSession } from "../../session/component/session-provider.js";
import { useWorkspaceDialogs } from "./workspace-dialogs.js";
import { RecentTeammateShortcuts } from "../../agent/component/recent-teammate-shortcuts.js";
import { TeammateNavigation } from "../../agent/component/teammate-navigation.js";
import { WorkspaceMenu } from "./workspace-menu.js";
import { DesktopWorkspaceActions } from "./desktop-workspace-actions.js";
import { useUpdateCount } from "../../update/hook/use-updates.js";
import { useChatViewport } from "../hook/use-chat-viewport.js";
import {
  UpdateCountBadge,
  unreadLinkLabel,
} from "../../update/component/update-count-badge.js";

const navigation = [
  { path: "/", label: "Home", icon: House },
  { path: "/updates", label: "Updates", icon: Bell },
  { path: "/team", label: "Your team", icon: Grid2X2 },
  { path: "/apps", label: "Apps", icon: Folder },
  { path: "/workspaces", label: "Workspaces", icon: Boxes },
  { path: "/keys", label: "Keys", icon: KeyRound },
];

/** Keep navigation stationary and let phone conversations use their own compact header. */
export function WorkspaceShell() {
  const { profile, signOut: endSession } = useSession();
  const agents = useAgents();
  const { open } = useWorkspaceDialogs();
  const updateCounts = useUpdateCount().data;
  const unreadUpdates = updateCounts?.unread ?? 0;
  /** Only Updates carries a count; other destinations have nothing unread. */
  const unreadFor = (path: string) => (path === "/updates" ? unreadUpdates : 0);
  const cache = useQueryClient();
  const { pathname } = useLocation();
  const content = useRef<HTMLElement>(null);
  const previousPath = useRef(pathname);
  const [signingOut, setSigningOut] = useState(false);
  const [error, setError] = useState("");
  const activeAgent = agents.data?.find(
    (agent) => pathname === `/team/${agent.id}`,
  );
  const isChat = pathname.startsWith("/team/");
  const viewport = useChatViewport(isChat);
  const label =
    activeAgent?.name ??
    (isChat ? "Teammate" : undefined) ??
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
    <div
      className={`shell${isChat ? " chat-shell" : ""}`}
      style={
        viewport
          ? ({
              "--chat-viewport-height": `${viewport.height}px`,
              "--chat-viewport-offset-top": `${viewport.offsetTop}px`,
            } as CSSProperties)
          : undefined
      }
    >
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
              aria-label={unreadLinkLabel(itemLabel, unreadFor(path))}
            >
              <Icon aria-hidden="true" />
              {itemLabel}
              <UpdateCountBadge count={unreadFor(path)} />
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
        <TeammateNavigation />
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
        <header className={`topbar ${activeAgent ? "chat-topbar" : ""}`}>
          {activeAgent ? (
            <Link
              to="/team"
              className="icon-button"
              aria-label="Back to your team"
            >
              <ArrowLeft aria-hidden="true" />
            </Link>
          ) : (
            <>
              <Brand className="mobile-wordmark" />
              <div className="breadcrumb">
                Your workspace <ChevronRight aria-hidden="true" />
                <span>{label}</span>
              </div>
            </>
          )}
          <div className="topbar-right">
            <DesktopWorkspaceActions onSignOut={() => void signOut()} />
            <div className="mobile-workspace-actions">
              <RecentTeammateShortcuts />
              <WorkspaceMenu onSignOut={() => void signOut()} />
            </div>
          </div>
        </header>
        <main
          id="workspace-content"
          data-dialog-fallback=""
          ref={content}
          tabIndex={-1}
          className={`content ${pathname === "/" ? "dashboard-content" : ""} ${isChat ? "chat-content" : ""}`}
        >
          <div key={pathname} className="route-content">
            <Outlet />
          </div>
        </main>
      </div>
      <nav className="mobile-nav" aria-label="Mobile workspace">
        {navigation.map(({ path, label: itemLabel, icon: Icon }) => {
          const shortLabel = itemLabel === "Your team" ? "Team" : itemLabel;
          return (
            <NavLink
              key={path}
              to={path}
              end
              className={({ isActive }) => (isActive ? "active" : "")}
              aria-label={unreadLinkLabel(shortLabel, unreadFor(path))}
            >
              <span className="mobile-nav-icon">
                <Icon aria-hidden="true" />
                <UpdateCountBadge count={unreadFor(path)} />
              </span>
              {shortLabel}
            </NavLink>
          );
        })}
      </nav>
    </div>
  );
}
