import type { AgentModelInfo } from "@everything/agent-contracts";
import type { AgentCatalog } from "../interface/agent-catalog.js";
import type {
  AgentModelInfoReader,
  AppliedModelReader,
} from "../interface/agent-model-info.js";
import type {
  ModelResolution,
  ProviderModels,
} from "../../provider/interface/provider-models.js";
import { ApplicationError } from "@everything/errors";

/** Keep fresh saved-selection discovery separate from the runtime's pinned resolution. */
export class AgentModelInfoService implements AgentModelInfoReader {
  /** Receive only ownership lookup, selection validation, resolution and applied-state readers. */
  constructor(
    private readonly agents: Pick<AgentCatalog, "get">,
    private readonly models: Pick<ProviderModels, "select">,
    private readonly resolution: ModelResolution,
    private readonly runtimes: AppliedModelReader,
  ) {}

  /** Discovery performs no inference; a provider failure never hides the applied snapshot. */
  async read(ownerId: string, agentId: string): Promise<AgentModelInfo> {
    const agent = await this.agents.get(ownerId, agentId);
    const applied = await this.runtimes.appliedModel(ownerId, agentId);
    if (!agent.inference)
      return { selected: null, applied, selectionError: false };
    try {
      const selected = await this.models.select(ownerId, agent.inference);
      return {
        selected: this.resolution.effective(agent.inference.provider, selected),
        applied,
        selectionError: false,
      };
    } catch (error) {
      if (!(error instanceof ApplicationError)) throw error;
      return { selected: null, applied, selectionError: true };
    }
  }
}
