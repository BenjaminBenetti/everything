import type {
  Agent,
  AgentList,
  CreateAgentInput,
} from "@everything/agent-contracts";
import type { JsonTransport } from "../../http/interface/json-transport.js";
import type { AgentDirectory } from "../interface/agent-directory.js";

/** Translate directory operations into the public API contract. */
export class HttpAgentDirectory implements AgentDirectory {
  // ===========================================
  // Construction
  // ===========================================

  /** Receive transport policy independently from the domain adapter. */
  constructor(private readonly transport: JsonTransport) {}

  // ===========================================
  // Operations
  // ===========================================

  /** Read saved definitions without loading or starting agent sessions. */
  async list(signal?: AbortSignal): Promise<Agent[]> {
    const result = await this.transport.request<AgentList>(
      "/v1/agents",
      signal ? { signal } : {},
    );
    return result.agents;
  }

  /** Persist a definition with the shared request fields. */
  create(input: CreateAgentInput): Promise<Agent> {
    return this.transport.request("/v1/agents", {
      method: "POST",
      body: JSON.stringify(input),
    });
  }

  /** Rename without submitting instructions or triggering work. */
  rename(id: string, name: string): Promise<Agent> {
    return this.transport.request(`/v1/agents/${encodeURIComponent(id)}`, {
      method: "PATCH",
      body: JSON.stringify({ name }),
    });
  }
}
