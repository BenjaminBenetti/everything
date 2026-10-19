import { useId, useState } from "react";
import { ArrowLeft, Info } from "lucide-react";
import { Link } from "react-router-dom";
import type { Agent } from "@everything/agent-contracts";
import { IconButton } from "@everything/ui/button";
import {
  mainActivityStatus,
  type MainActivity,
} from "../model/main-activity.js";
import { ConversationTeammateCard } from "./conversation-teammate-card.js";
import { TeammatePresence } from "./teammate-presence.js";
import { ConversationWorkspacesCard } from "./conversation-workspaces-card.js";

/**
 * Keep details beside desktop messages and behind an info button on smaller screens. Every visible
 * avatar of the main teammate shows its activity, and screen readers hear one status for both layouts.
 */
export function ConversationDetails({
  agent,
  activity,
  backgroundCount,
  onEdit,
}: {
  agent: Agent;
  activity: MainActivity;
  backgroundCount: number;
  onEdit: () => void;
}) {
  const panelId = useId();
  const [expanded, setExpanded] = useState(false);
  return (
    <div className="chat-sidebar" data-expanded={expanded}>
      <p className="sr-only" role="status">
        {mainActivityStatus(agent.name, activity)}
      </p>
      <header className="chat-mobile-header">
        <Link
          to="/team"
          className="icon-button chat-mobile-back"
          aria-label="Back to your team"
        >
          <ArrowLeft aria-hidden="true" />
        </Link>
        <TeammatePresence agent={agent} activity={activity} small />
        <div className="chat-mobile-identity">
          <h1 title={agent.name}>{agent.name}</h1>
          {backgroundCount > 0 && (
            <span
              className="chat-mobile-background"
              role="status"
              aria-label="Active background teammates"
            >
              <span
                className="chat-teammate-background-dot"
                aria-hidden="true"
              />
              {backgroundCount} background
            </span>
          )}
        </div>
        <IconButton
          label="Details"
          className="chat-details-toggle"
          aria-expanded={expanded}
          aria-controls={panelId}
          onClick={() => setExpanded((current) => !current)}
        >
          <Info aria-hidden="true" />
        </IconButton>
      </header>
      <div id={panelId} className="chat-sidebar-panel">
        <ConversationTeammateCard
          agent={agent}
          activity={activity}
          backgroundCount={backgroundCount}
          onEdit={onEdit}
        />
        <ConversationWorkspacesCard
          agentId={agent.id}
          name={agent.name}
          avatarId={agent.avatarId}
        />
      </div>
    </div>
  );
}
