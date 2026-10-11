import { useState, type FormEvent } from "react";
import { useMutation, useQueryClient } from "@tanstack/react-query";
import { agentLimits, type Agent } from "@everything/agent-contracts";
import { Button } from "@everything/ui/button";
import { Dialog } from "@everything/ui/dialog";
import { useAgentDirectory } from "./agent-directory-provider.js";
import { useSession } from "../../session/component/session-provider.js";

/** Create definitions or rename an existing one, preserving drafts after API failures. */
export function AgentEditor({
  agent,
  onClose,
  onSaved,
}: {
  agent?: Agent;
  onClose: () => void;
  onSaved: (message: string) => void;
}) {
  const [name, setName] = useState(agent?.name ?? "");
  const [instructions, setInstructions] = useState("");
  const directory = useAgentDirectory();
  const cache = useQueryClient();
  const { profile } = useSession();
  const save = useMutation({
    mutationFn: () =>
      agent
        ? directory.rename(agent.id, name.trim())
        : directory.create({
            name: name.trim(),
            systemPrompt:
              instructions.trim() || "Help me with my everyday work.",
          }),
    onSuccess: async () => {
      await cache.invalidateQueries({ queryKey: ["agents", profile?.subject] });
      onSaved(agent ? "Agent renamed." : "Your new agent is ready.");
      onClose();
    },
  });
  /** Prevent duplicate submissions and reject names that contain only spaces. */
  function submit(event: FormEvent<HTMLFormElement>): void {
    event.preventDefault();
    if (name.trim() && !save.isPending) save.mutate();
  }
  return (
    <Dialog
      title={agent ? "Make it yours." : "Someone new."}
      description="Choose a name for your agent. You can change it whenever you like."
      onClose={() => {
        if (!save.isPending) onClose();
      }}
    >
      <form onSubmit={submit}>
        <label className="field">
          Agent name
          <input
            autoFocus
            required
            maxLength={agentLimits.nameLength}
            placeholder="A name that feels right"
            value={name}
            onChange={(event) => setName(event.target.value)}
            disabled={save.isPending}
          />
        </label>
        {!agent && (
          <label className="field">
            A little about them <span className="muted">(optional)</span>
            <textarea
              rows={3}
              maxLength={agentLimits.systemPromptLength}
              placeholder="What will you work on together?"
              value={instructions}
              onChange={(event) => setInstructions(event.target.value)}
              disabled={save.isPending}
            />
            <small>These instructions help shape how your agent works.</small>
          </label>
        )}
        {save.isError && (
          <p className="form-error" role="alert">
            {save.error.message}
          </p>
        )}
        <div className="dialog-actions">
          <Button variant="light" disabled={save.isPending} onClick={onClose}>
            Cancel
          </Button>
          <Button type="submit" disabled={!name.trim() || save.isPending}>
            {save.isPending
              ? "Saving…"
              : agent
                ? "Save changes"
                : "Create agent"}
          </Button>
        </div>
      </form>
    </Dialog>
  );
}
