import { NavLink } from "react-router-dom";
import { useRecentAgents } from "../hook/use-recent-agents.js";
import { TeammateAvatar } from "./teammate-avatar.js";

/** Offer ongoing chat shortcuts with the most recently used teammate on the right. */
export function RecentTeammateShortcuts() {
  const { data: recent } = useRecentAgents();
  if (!recent?.length) return null;
  return (
    <nav className="teammate-shortcuts" aria-label="Recent teammate shortcuts">
      {recent
        .slice(0, 3)
        .reverse()
        .map((agent) => (
          <NavLink
            key={agent.id}
            to={`/team/${encodeURIComponent(agent.id)}`}
            className="teammate-shortcut"
            aria-label={`Back to ${agent.name}`}
            title={`Back to ${agent.name}`}
          >
            <TeammateAvatar avatarId={agent.avatarId} small />
          </NavLink>
        ))}
    </nav>
  );
}
