import { useMutation, useQueryClient } from "@tanstack/react-query";
import type { Agent } from "@everything/agent-contracts";
import { ConfirmationDialog } from "@everything/ui/confirmation-dialog";
import { useAgentDirectory } from "./agent-directory-provider.js";
import { useSession } from "../../session/component/session-provider.js";

/** Remove a confirmed teammate through the directory and reconcile every visible team listing. */
export function AgentDeletionDialog({
  agent,
  onCancel,
  onDeleted,
}: {
  agent: Agent;
  onCancel: () => void;
  onDeleted: () => void;
}) {
  const directory = useAgentDirectory();
  const cache = useQueryClient();
  const { profile } = useSession();
  const queryKey = ["agents", profile?.subject];
  const removal = useMutation({
    mutationFn: () => directory.delete(agent.id),
    onSuccess: async () => {
      const conversationKey = ["conversation", profile?.subject, agent.id];
      await cache.cancelQueries({ queryKey: conversationKey });
      cache.removeQueries({ queryKey: conversationKey });
      await cache.cancelQueries({ queryKey });
      cache.setQueryData<Agent[]>(queryKey, (agents) =>
        agents?.filter((item) => item.id !== agent.id),
      );
      await cache.invalidateQueries({ queryKey });
      onDeleted();
    },
  });
  return (
    <ConfirmationDialog
      title="Delete teammate?"
      description={`“${agent.name}” and their saved data will be permanently deleted. This can’t be undone.`}
      confirmLabel="Delete teammate"
      pendingLabel="Deleting…"
      pending={removal.isPending}
      {...(removal.isError ? { error: removal.error.message } : {})}
      onCancel={() => {
        if (!removal.isPending) onCancel();
      }}
      onConfirm={() => {
        if (!removal.isPending) removal.mutate();
      }}
    />
  );
}
