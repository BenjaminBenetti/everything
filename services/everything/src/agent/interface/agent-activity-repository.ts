import type {
  OwnerScope,
  Repository,
} from "@everything/persistence/repository";
import type { AgentRecord } from "../model/agent-record.js";

/** Scope recent teammate metadata to the owner without granting profile mutation. */
export interface AgentActivityRepository extends Repository<
  AgentRecord,
  OwnerScope
> {
  /** Advance the owned teammate's interaction timestamp without accepting older arrivals. */
  touch(scope: OwnerScope, agentId: string, at: string): Promise<void>;
}

/** Activity services need only listing and recording capabilities. */
export type AgentActivityStore = Pick<
  AgentActivityRepository,
  "list" | "touch"
>;
