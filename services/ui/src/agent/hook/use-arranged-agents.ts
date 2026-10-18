import { useMemo } from "react";
import type { Agent } from "@everything/agent-contracts";
import { useTeammateOrder } from "../../settings/component/workspace-settings-provider.js";
import { arrangeTeammates } from "../model/teammate-order.js";

/**
 * Arrange teammates in the owner's saved order once it has loaded. When the order can't load,
 * teammates keep creation order and `orderLoaded` stays false, so nothing overwrites the saved order.
 */
export function useArrangedAgents(agents: readonly Agent[] | undefined) {
  const order = useTeammateOrder();
  const teammates = useMemo(
    () =>
      agents && !order.isPending
        ? arrangeTeammates(agents, order.data?.teammateIds ?? [])
        : undefined,
    [agents, order.isPending, order.data],
  );
  return {
    teammates,
    orderLoaded: order.isSuccess,
    orderFailed: order.isError,
    /** Load the saved order again after a failure. */
    retryOrder: () => void order.refetch(),
  };
}
