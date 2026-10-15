import { MessageSquare, type LucideIcon } from "lucide-react";
import type { Agent } from "@everything/agent-contracts";
import {
  defaultAgentAvatarId,
  type AgentAvatarId,
} from "@everything/agent-contracts/avatar";
import type { Update, UpdateSummaryStatus } from "@everything/update-contracts";

/** How a feed row shows one update and where opening it leads. */
export interface UpdatePresentation {
  /** The page that shows the update's source in context. */
  readonly to: string;
  /** Who or what the update comes from. */
  readonly source: string;
  /** Teammate artwork; updates without one show their icon instead. */
  readonly avatarId?: AgentAvatarId;
  readonly icon: LucideIcon;
  /** What opening the row does, for screen readers. */
  readonly action: string;
}

/** Labels for summaries that aren't ready; a ready summary needs no label. */
export const summaryLabels: Readonly<
  Record<UpdateSummaryStatus, string | undefined>
> = {
  ready: undefined,
  pending: "Summarizing…",
  unavailable: "Message preview",
  disabled: "Message preview",
};

/** Describe each kind of update; a new kind needs only a new case here. */
export function presentUpdate(
  update: Update,
  agents: readonly Agent[] = [],
): UpdatePresentation | undefined {
  switch (update.kind) {
    case "message": {
      const agent = agents.find((item) => item.id === update.agentId);
      return {
        to: `/team/${encodeURIComponent(update.agentId)}?message=${encodeURIComponent(update.messageId)}`,
        source: agent?.name ?? "Teammate",
        avatarId: agent?.avatarId ?? defaultAgentAvatarId,
        icon: MessageSquare,
        action: "Open message",
      };
    }
    default:
      // Skip kinds this client doesn't know yet; the compiler flags a missing case.
      update.kind satisfies never;
      return undefined;
  }
}
