import type { Agent } from "@everything/agent-contracts";
import { IconButton } from "@everything/ui/button";
import { Settings2 } from "lucide-react";
import { TeammateAvatar } from "../../agent/component/teammate-avatar.js";
import { effortLabels } from "../../agent/model/inference-options.js";
import { providerOptions } from "../../provider/model/provider-options.js";

/** Present the current teammate and saved model within the workspace's single header. */
export function ConversationHeading({
  agent,
  onDetails,
}: {
  agent: Agent;
  onDetails: () => void;
}) {
  const model = agent.inference
    ? `${providerOptions[agent.inference.provider].title} · ${agent.inference.model} · ${effortLabels[agent.inference.effort]}`
    : "Choose a model to start messaging";
  return (
    <div className="chat-heading">
      <TeammateAvatar avatarId={agent.avatarId} small />
      <div className="chat-teammate">
        <h1 title={agent.name}>{agent.name}</h1>
        <p title={model}>
          {agent.inference ? (
            <>
              <span className="chat-provider">
                {providerOptions[agent.inference.provider].title} ·{" "}
              </span>
              {agent.inference.model} · {effortLabels[agent.inference.effort]}
            </>
          ) : (
            model
          )}
        </p>
      </div>
      <IconButton label="Teammate details" onClick={onDetails}>
        <Settings2 aria-hidden="true" />
      </IconButton>
    </div>
  );
}
