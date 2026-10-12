import { ArrowRight, Pencil } from "lucide-react";
import type { Agent } from "@everything/agent-contracts";
import { TeammateAvatar } from "./teammate-avatar.js";
import { IconButton } from "@everything/ui/button";
import { useWorkspaceDialogs } from "../../workspace/component/workspace-dialogs.js";

/** Show a saved teammate with an idle avatar and access to their profile details. */
export function AgentCard({ agent }: { agent: Agent }) {
  const { open } = useWorkspaceDialogs();
  return (
    <article className="agent-card">
      <IconButton
        className="edit-teammate"
        label={`Edit ${agent.name}`}
        onClick={() => open({ kind: "editor", agent })}
      >
        <Pencil aria-hidden="true" />
      </IconButton>
      <button
        className="agent-open"
        aria-label={`View ${agent.name}`}
        onClick={() => open({ kind: "details", agent })}
      >
        <TeammateAvatar
          avatarId={agent.avatarId}
          animation="idle"
          animationSeed={agent.id}
        />
        <h2>{agent.name}</h2>
        <p className="agent-role">Teammate</p>
        <p className="agent-preview">{agent.systemPrompt}</p>
        <div className="card-bottom">
          <span className="dot" />
          Saved<span className="time">View details</span>
          <ArrowRight aria-hidden="true" />
        </div>
      </button>
    </article>
  );
}
