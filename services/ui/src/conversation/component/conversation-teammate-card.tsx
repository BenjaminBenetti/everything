import type { Agent } from "@everything/agent-contracts";
import { IconButton } from "@everything/ui/button";
import { Pencil } from "lucide-react";
import { TeammateAvatar } from "../../agent/component/teammate-avatar.js";
import { effortLabels } from "../../agent/model/inference-options.js";
import { providerOptions } from "../../provider/model/provider-options.js";

/** Show the teammate's idle avatar, identity, model settings, and editing action beside their conversation. */
export function ConversationTeammateCard({
  agent,
  onEdit,
}: {
  agent: Agent;
  onEdit: () => void;
}) {
  return (
    <aside
      className="chat-teammate-card"
      aria-label={`${agent.name} teammate info`}
    >
      <div className="chat-teammate-identity">
        <TeammateAvatar
          avatarId={agent.avatarId}
          animation="idle"
          animationSeed={agent.id}
        />
        <h1>{agent.name}</h1>
        <IconButton label={`Edit ${agent.name}`} onClick={onEdit}>
          <Pencil aria-hidden="true" />
        </IconButton>
      </div>
      {agent.inference ? (
        <dl className="chat-teammate-model">
          <div>
            <dt>Provider</dt>
            <dd>{providerOptions[agent.inference.provider].title}</dd>
          </div>
          <div>
            <dt>Model</dt>
            <dd>{agent.inference.model}</dd>
          </div>
          <div>
            <dt>Effort</dt>
            <dd>{effortLabels[agent.inference.effort]}</dd>
          </div>
        </dl>
      ) : (
        <p className="chat-teammate-setup">
          Choose a model to start messaging.
        </p>
      )}
    </aside>
  );
}
