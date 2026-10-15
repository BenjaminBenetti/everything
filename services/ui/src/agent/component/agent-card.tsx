import { ArrowRight, Pencil, Ellipsis } from "lucide-react";
import type { Agent } from "@everything/agent-contracts";
import { TeammateAvatar } from "./teammate-avatar.js";
import { IconButton } from "@everything/ui/button";
import { useWorkspaceDialogs } from "../../workspace/component/workspace-dialogs.js";
import { Link } from "react-router-dom";
import {
  UpdateCountBadge,
  unreadLinkLabel,
} from "../../update/component/update-count-badge.js";

/** Open the teammate's ongoing conversation with its unread count and separate profile controls. */
export function AgentCard({
  agent,
  unreadCount,
}: {
  agent: Agent;
  unreadCount: number;
}) {
  const { open } = useWorkspaceDialogs();
  return (
    <article className="agent-card">
      <IconButton
        className="view-teammate"
        label={`View ${agent.name}`}
        onClick={() => open({ kind: "details", agent })}
      >
        <Ellipsis aria-hidden="true" />
      </IconButton>
      <IconButton
        className="edit-teammate"
        label={`Edit ${agent.name}`}
        onClick={() => open({ kind: "editor", agent })}
      >
        <Pencil aria-hidden="true" />
      </IconButton>
      <Link
        className="agent-open"
        aria-label={
          unreadLinkLabel(`Chat with ${agent.name}`, unreadCount) ??
          `Chat with ${agent.name}`
        }
        to={`/team/${encodeURIComponent(agent.id)}`}
      >
        <TeammateAvatar
          avatarId={agent.avatarId}
          animation="idle"
          animationSeed={agent.id}
        />
        <h2>
          <span>{agent.name}</span>
          <UpdateCountBadge count={unreadCount} />
        </h2>
        <p className="agent-role">Teammate</p>
        <p className="agent-preview">{agent.systemPrompt}</p>
        <div className="card-bottom">
          <span className="dot" />
          Teammate<span className="time">Open chat</span>
          <ArrowRight aria-hidden="true" />
        </div>
      </Link>
    </article>
  );
}
