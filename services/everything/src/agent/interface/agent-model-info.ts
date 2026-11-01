import type { AgentModelInfo } from "@everything/agent-contracts";
import type { EffectiveModel } from "@everything/provider-contracts/inference";

/** Read current model metadata without starting inference or exposing provider responses. */
export interface AgentModelInfoReader {
  read(ownerId: string, agentId: string): Promise<AgentModelInfo>;
}

/** Only the applied runtime snapshot is needed by model-information consumers. */
export interface AppliedModelReader {
  appliedModel(
    ownerId: string,
    agentId: string,
  ): Promise<EffectiveModel | null>;
}
