import { ArrowRight, Pencil } from "lucide-react";
import type { Agent } from "@everything/agent-contracts";
import { AgentAvatar } from "@everything/ui/brand";
import { IconButton } from "@everything/ui/button";
import { useWorkspaceDialogs } from "../../workspace/component/workspace-dialogs.js";

/** A saved definition opens its details, with conversation entry deliberately deferred. */
export function AgentCard({ agent }: { agent: Agent }) {
  const { open } = useWorkspaceDialogs();
  return (
    <article className="agent-card">
      <IconButton
        className="rename"
        label={`Rename ${agent.name}`}
        onClick={() => open({ kind: "editor", agent })}
      >
        <Pencil aria-hidden="true" />
      </IconButton>
      <button
        className="agent-open"
        aria-label={`View ${agent.name}`}
        onClick={() => open({ kind: "details", agent })}
      >
        <AgentAvatar name={agent.name} />
        <h2>{agent.name}</h2>
        <p className="agent-role">Your everyday collaborator</p>
        <p className="agent-preview">{agent.systemPrompt}</p>
        <div className="card-bottom">
          <span className="dot" />
          Agent saved<span className="time">View details</span>
          <ArrowRight aria-hidden="true" />
        </div>
      </button>
    </article>
  );
}
