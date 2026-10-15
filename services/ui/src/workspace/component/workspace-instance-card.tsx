import { useId, useState } from "react";
import { useMutation, useQueryClient } from "@tanstack/react-query";
import {
  Box,
  Cpu,
  LoaderCircle,
  MemoryStick,
  Pause,
  Play,
  Trash2,
} from "lucide-react";
import { IconButton } from "@everything/ui/button";
import { ConfirmationDialog } from "@everything/ui/confirmation-dialog";
import type {
  WorkspaceInstance,
  WorkspaceStatus,
} from "@everything/workspace-contracts/instance";
import {
  useWorkspaceDirectory,
  useWorkspaceQueryKey,
} from "./workspace-directory-provider.js";
import {
  formatWorkspaceCpu,
  formatWorkspaceMemory,
  workspaceStatusLabels,
} from "../model/workspace-presentation.js";
import { WorkspaceStatusIndicator } from "./workspace-status-indicator.js";

type WorkspaceAction = "start" | "stop" | "delete";
const pendingStatuses: Record<WorkspaceAction, WorkspaceStatus> = {
  start: "starting",
  stop: "stopping",
  delete: "deleting",
};
const completedStatuses: Record<WorkspaceAction, WorkspaceStatus> = {
  start: "running",
  stop: "stopped",
  delete: "deleting",
};

/** Show one instance and guard its controls while a lifecycle action is in progress. */
export function WorkspaceInstanceCard({
  workspace,
  unavailable,
}: {
  workspace: WorkspaceInstance;
  unavailable: boolean;
}) {
  const heading = useId();
  const directory = useWorkspaceDirectory();
  const queryKey = useWorkspaceQueryKey();
  const cache = useQueryClient();
  const [confirmDelete, setConfirmDelete] = useState(false);
  const mutation = useMutation({
    mutationFn: (action: WorkspaceAction) =>
      directory[action]({ type: workspace.type, name: workspace.name }),
    onMutate: () => cache.cancelQueries({ queryKey }),
    onSuccess: async (_result, action) => {
      await cache.cancelQueries({ queryKey });
      cache.setQueryData<readonly WorkspaceInstance[]>(queryKey, (items) =>
        items?.map((item) =>
          item.type === workspace.type && item.name === workspace.name
            ? {
                ...item,
                status: completedStatuses[action],
                resources: { cpuCores: null, memoryBytes: null },
              }
            : item,
        ),
      );
      setConfirmDelete(false);
    },
    onSettled: () => cache.invalidateQueries({ queryKey }),
  });
  const status = mutation.isPending
    ? pendingStatuses[mutation.variables]
    : workspace.status;
  const canControl =
    !unavailable &&
    !mutation.isPending &&
    (status === "running" || status === "stopped");
  const action = status === "running" ? "stop" : "start";
  const label = action === "stop" ? "Stop" : "Start";
  return (
    <article
      className="workspace-instance-card"
      aria-labelledby={heading}
      aria-busy={mutation.isPending}
    >
      <div className="workspace-instance-heading">
        <span className="workspace-instance-icon">
          <Box aria-hidden="true" />
        </span>
        <div>
          <h3 id={heading}>{workspace.name}</h3>
          <p className="workspace-instance-type">
            <span>Type</span> {workspace.type}
          </p>
        </div>
      </div>
      <dl className="workspace-resources">
        <div
          title={
            workspace.resources.cpuCores === null
              ? "CPU usage unavailable"
              : "Current CPU usage"
          }
        >
          <dt>
            <Cpu aria-hidden="true" /> CPU
          </dt>
          <dd>{formatWorkspaceCpu(workspace.resources.cpuCores)}</dd>
        </div>
        <div
          title={
            workspace.resources.memoryBytes === null
              ? "Memory usage unavailable"
              : "Current memory usage"
          }
        >
          <dt>
            <MemoryStick aria-hidden="true" />
            <abbr title="Memory">MEM</abbr>
          </dt>
          <dd>{formatWorkspaceMemory(workspace.resources.memoryBytes)}</dd>
        </div>
      </dl>
      <div className="workspace-instance-footer">
        <WorkspaceStatusIndicator status={status} />
        <div className="workspace-instance-controls">
          <IconButton
            label={`${mutation.isPending ? workspaceStatusLabels[status] : label} ${workspace.name}`}
            disabled={!canControl}
            onClick={() => mutation.mutate(action)}
          >
            {mutation.isPending ? (
              <LoaderCircle
                className="workspace-action-spinner"
                aria-hidden="true"
              />
            ) : status === "running" ? (
              <Pause aria-hidden="true" />
            ) : (
              <Play aria-hidden="true" />
            )}
          </IconButton>
          {status === "stopped" && (
            <IconButton
              label={`Delete ${workspace.name}`}
              className="workspace-delete"
              disabled={!canControl}
              onClick={(event) => {
                event.currentTarget.setAttribute("data-dialog-return", "");
                mutation.reset();
                setConfirmDelete(true);
              }}
            >
              <Trash2 aria-hidden="true" />
            </IconButton>
          )}
        </div>
      </div>
      {mutation.isError && !confirmDelete && (
        <p className="form-error" role="alert">
          The workspace action couldn’t finish. Refresh its status and try
          again.
        </p>
      )}
      {confirmDelete && (
        <ConfirmationDialog
          title="Delete workspace?"
          description={`“${workspace.name}” (${workspace.type}) and its saved files will be permanently deleted. This can’t be undone.`}
          confirmLabel="Delete workspace"
          pendingLabel="Deleting…"
          pending={mutation.isPending}
          {...(mutation.isError
            ? {
                error:
                  "The workspace couldn’t be deleted. It may no longer be stopped. Close this dialog, check its status, and try again.",
              }
            : {})}
          onCancel={() => {
            if (!mutation.isPending) setConfirmDelete(false);
          }}
          onConfirm={() => {
            if (!mutation.isPending) mutation.mutate("delete");
          }}
        />
      )}
    </article>
  );
}
