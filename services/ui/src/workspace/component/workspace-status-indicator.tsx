import type { WorkspaceStatus } from "@everything/workspace-contracts/instance";
import { workspaceStatusLabels } from "../model/workspace-presentation.js";

/** Share lifecycle labels and status colors between directory cards and the conversation overview. */
export function WorkspaceStatusIndicator({
  status,
}: {
  status: WorkspaceStatus;
}) {
  return (
    <span
      className={`workspace-instance-status status-${status}`}
      role="status"
    >
      <span className="workspace-status-dot" aria-hidden="true" />
      {workspaceStatusLabels[status]}
    </span>
  );
}
