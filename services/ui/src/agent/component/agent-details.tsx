import type { Agent } from "@everything/agent-contracts";
import { Trash2 } from "lucide-react";
import { TeammateAvatar } from "./teammate-avatar.js";
import { Button } from "@everything/ui/button";
import { Dialog } from "@everything/ui/dialog";
import { providerOptions } from "../../provider/model/provider-options.js";
import { effortLabels, fastModeLabels } from "../model/inference-options.js";
import { Link } from "react-router-dom";

/** Inspect a saved profile with separated editing and deletion actions. */
export function AgentDetails({
  agent,
  onClose,
  onEdit,
  onDelete,
  focusDelete = false,
}: {
  agent: Agent;
  onClose: () => void;
  onEdit: () => void;
  onDelete: () => void;
  focusDelete?: boolean;
}) {
  return (
    <Dialog
      title={agent.name}
      description="View your teammate’s details."
      onClose={onClose}
      footer={
        <div className="dialog-actions teammate-editor-actions">
          <Button
            variant="danger-quiet"
            className="teammate-delete-action"
            autoFocus={focusDelete}
            onClick={onDelete}
          >
            <Trash2 aria-hidden="true" />
            Delete
          </Button>
          <Button variant="light" onClick={onClose}>
            Close
          </Button>
          <Button onClick={onEdit}>Edit</Button>
        </div>
      }
    >
      <TeammateAvatar avatarId={agent.avatarId} />
      <p className="eyebrow">Description</p>
      <p className="agent-instructions">{agent.systemPrompt}</p>
      <p className="eyebrow">Model settings</p>
      {agent.inference ? (
        <dl className="teammate-model-details">
          <dt>Provider</dt>
          <dd>{providerOptions[agent.inference.provider].title}</dd>
          <dt>Model</dt>
          <dd>{agent.inference.model}</dd>
          <dt>Effort level</dt>
          <dd>{effortLabels[agent.inference.effort]}</dd>
          {agent.inference.speed === "fast" && (
            <>
              <dt>Speed</dt>
              <dd>{fastModeLabels.details}</dd>
            </>
          )}
        </dl>
      ) : (
        <p className="muted">No model selected.</p>
      )}
      <Link
        className="text-link"
        to={`/team/${encodeURIComponent(agent.id)}`}
        onClick={onClose}
      >
        Open chat
      </Link>
    </Dialog>
  );
}
