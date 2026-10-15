import { useId } from "react";
import { Box } from "lucide-react";
import type { AgentAvatarId } from "@everything/agent-contracts/avatar";
import { TeammateAvatar } from "../../agent/component/teammate-avatar.js";
import { useWorkspaceActivity } from "../../workspace/hook/use-workspace-activity.js";
import { WorkspaceStatusIndicator } from "../../workspace/component/workspace-status-indicator.js";

/** Show the current teammate's ten most recently used workspaces, including its private forks. */
export function ConversationWorkspacesCard({
  agentId,
  name,
  avatarId,
}: {
  agentId: string;
  name: string;
  avatarId: AgentAvatarId;
}) {
  const heading = useId();
  const { query, workspaces } = useWorkspaceActivity(agentId);
  return (
    <aside className="chat-workspaces-card" aria-labelledby={heading}>
      <h2 id={heading}>
        <Box aria-hidden="true" /> Workspaces
      </h2>
      {query.isPending ? (
        <p className="chat-workspaces-notice" role="status">
          Loading workspaces…
        </p>
      ) : query.isError ? (
        <p className="chat-workspaces-notice" role="status">
          Workspace updates unavailable. Reconnecting…
        </p>
      ) : workspaces.length === 0 ? (
        <p className="chat-workspaces-notice">
          {name} isn't using a workspace right now
        </p>
      ) : null}
      {workspaces.length > 0 && (
        <ul
          className="chat-workspace-list"
          aria-label={`${name}’s recent workspaces`}
        >
          {workspaces.map((workspace) => (
            <li
              key={JSON.stringify([workspace.type, workspace.name])}
              className={`chat-workspace-row${workspace.active ? " is-active" : ""}`}
            >
              <span className="chat-workspace-activity">
                {workspace.active && (
                  <span
                    role="img"
                    aria-label={`${name} is using this workspace`}
                    title={`${name} is using this workspace`}
                  >
                    <TeammateAvatar
                      avatarId={avatarId}
                      small
                      animation="typing"
                      animationSeed={`${agentId}:${workspace.type}:${workspace.name}`}
                    />
                  </span>
                )}
              </span>
              <span
                className="chat-workspace-name"
                title={`${workspace.name} (${workspace.type})`}
              >
                {workspace.name}
              </span>
              <WorkspaceStatusIndicator
                status={query.isError ? "unknown" : workspace.status}
              />
            </li>
          ))}
        </ul>
      )}
    </aside>
  );
}
