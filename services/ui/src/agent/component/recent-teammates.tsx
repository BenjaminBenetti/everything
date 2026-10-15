import { ArrowRight } from "lucide-react";
import { Link } from "react-router-dom";
import { Button } from "@everything/ui/button";
import { useRecentAgents } from "../hook/use-recent-agents.js";
import { TeammateAvatar } from "./teammate-avatar.js";

/** Offer direct links back to the owner's three most recently used teammates. */
export function RecentTeammates() {
  const recent = useRecentAgents();
  if (recent.isPending)
    return (
      <p className="recent-empty" role="status">
        Loading recent teammates…
      </p>
    );
  if (recent.isError)
    return (
      <div className="recent-empty" role="alert">
        <p>Recent teammates couldn’t load.</p>
        <Button variant="light" onClick={() => void recent.refetch()}>
          Try again
        </Button>
      </div>
    );
  if (!recent.data.length)
    return <p className="recent-empty">Open a teammate to find them here.</p>;
  return (
    <ul className="recent-teammates" aria-label="Recent teammates">
      {recent.data.map((agent) => (
        <li key={agent.id}>
          <Link
            className="recent-teammate"
            to={`/team/${encodeURIComponent(agent.id)}`}
          >
            <TeammateAvatar avatarId={agent.avatarId} small />
            <span>{agent.name}</span>
            <ArrowRight aria-hidden="true" />
          </Link>
        </li>
      ))}
    </ul>
  );
}
