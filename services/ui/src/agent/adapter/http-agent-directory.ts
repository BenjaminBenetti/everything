import type {
  Agent,
  AgentList,
  CreateAgentInput,
  UpdateAgentInput,
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

  /** Read the recent teammate list in server-defined interaction order. */
  async recent(signal?: AbortSignal): Promise<Agent[]> {
    const result = await this.transport.request<AgentList>(
      "/v1/agents/recent",
      signal ? { signal } : {},
    );
    return result.agents;
  }

  /** Record a visit without reading, creating, or switching conversation histories. */
  touch(id: string): Promise<void> {
    return this.transport.request<void>(
      `/v1/agents/${encodeURIComponent(id)}/interactions`,
      { method: "POST" },
    );
  }

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

  /** Persist editable profile fields without triggering work. */
  update(id: string, input: UpdateAgentInput): Promise<Agent> {
    return this.transport.request(`/v1/agents/${encodeURIComponent(id)}`, {
      method: "PATCH",
      body: JSON.stringify(input),
    });
  }

  /** Delegate removal to the API's ownership-scoped lifecycle. */
  delete(id: string): Promise<void> {
    return this.transport.request<void>(
      `/v1/agents/${encodeURIComponent(id)}`,
      { method: "DELETE" },
    );
  }
}
