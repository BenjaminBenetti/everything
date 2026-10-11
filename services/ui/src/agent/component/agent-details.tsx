import type { Agent } from "@everything/agent-contracts";
import { AgentAvatar } from "@everything/ui/brand";
import { Button } from "@everything/ui/button";
import { Dialog } from "@everything/ui/dialog";

/** Inspect saved instructions without exposing an unfinished conversation page. */
export function AgentDetails({
  agent,
  onClose,
  onRename,
}: {
  agent: Agent;
  onClose: () => void;
  onRename: () => void;
}) {
  return (
    <Dialog
      title={agent.name}
      description="A little about your agent."
      onClose={onClose}
    >
      <AgentAvatar name={agent.name} />
      <p className="eyebrow">Their instructions</p>
      <p className="agent-instructions">{agent.systemPrompt}</p>
      <p className="availability-note">
        Conversations are coming in a future update.
      </p>
      <div className="dialog-actions">
        <Button variant="light" onClick={onClose}>
          Close
        </Button>
        <Button onClick={onRename}>Rename agent</Button>
      </div>
    </Dialog>
  );
}
