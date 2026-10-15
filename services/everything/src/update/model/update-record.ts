import type { OwnedEntity } from "@everything/persistence/entity";
import type { UpdateKind } from "@everything/update-contracts";
import type { AgentDefinition } from "../../agent/model/agent.js";
import type { MessageRecord } from "../../conversation/model/message-record.js";
import type { StoredGeneralSettings } from "../../settings/model/general-settings.js";

/** Kinds the database accepts; each also needs a contract variant, source columns, and a mapping. */
export const updateKinds = ["message"] as const satisfies readonly UpdateKind[];

/** Durable summary progress; a claim moves pending work to generating before any model call. */
export const storedSummaryStatuses = [
  "pending",
  "generating",
  "ready",
  "failed",
] as const;
export type StoredSummaryStatus = (typeof storedSummaryStatuses)[number];

/** ORM mapping of one update, with the typed references and relations of every kind's source. */
export interface UpdateRecord extends OwnedEntity {
  /** Optional owner preferences; summaries require an explicit opt-in. */
  readonly generalSettings?: StoredGeneralSettings;
  readonly kind: UpdateKind;
  /** Insertion order; PostgreSQL bigint values are mapped to strings. */
  readonly sequence: string;
  /** The teammate a `message` update belongs to. */
  readonly agentId: string | null;
  readonly agent?: AgentDefinition;
  /** The delivered message a `message` update points to, loaded with every update. */
  readonly messageId: string | null;
  readonly message?: MessageRecord;
  readonly summary: string | null;
  readonly summaryStatus: StoredSummaryStatus;
  readonly summaryStartedAt: string | null;
  /** The first explicit receipt, or null while the update is unread. */
  readonly readAt: string | null;
}
