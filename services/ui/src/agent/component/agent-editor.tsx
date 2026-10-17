import { useEffect, useId, useRef, useState, type FormEvent } from "react";
import { useMutation, useQueryClient } from "@tanstack/react-query";
import { agentLimits, type Agent } from "@everything/agent-contracts";
import type { AgentAvatarId } from "@everything/agent-contracts/avatar";
import { Button } from "@everything/ui/button";
import { Dialog } from "@everything/ui/dialog";
import { useAgentDirectory } from "./agent-directory-provider.js";
import { useSession } from "../../session/component/session-provider.js";
import { AvatarPicker } from "./avatar-picker.js";
import { TeammateAvatar } from "./teammate-avatar.js";
import { randomTeammateAvatarId } from "../model/teammate-avatars.js";
import { InferenceFields } from "./inference-fields.js";
import {
  draftSelection,
  inferenceDraft,
  isChangedDraft,
  type InferenceDraft,
} from "../model/inference-draft.js";

/** Require a model for new teammates and preserve the complete profile draft after API failures. */
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
  const [description, setDescription] = useState(agent?.systemPrompt ?? "");
  const [avatarId, setAvatarId] = useState<AgentAvatarId>(
    () => agent?.avatarId ?? randomTeammateAvatarId(),
  );
  const [avatarChoice, setAvatarChoice] = useState(avatarId);
  const [choosingAvatar, setChoosingAvatar] = useState(false);
  const [inference, setInference] = useState<InferenceDraft>(() =>
    inferenceDraft(agent?.inference),
  );
  const [validInference, setValidInference] = useState(false);
  const inferenceChanged = isChangedDraft(inference, agent?.inference);
  const selection = draftSelection(inference);
  const inferenceReady =
    (!!agent && !inferenceChanged) || (validInference && !!selection);
  const formId = useId();
  const avatarButton = useRef<HTMLButtonElement>(null);
  const wasChoosingAvatar = useRef(false);
  const directory = useAgentDirectory();
  const cache = useQueryClient();
  const { profile } = useSession();
  useEffect(() => {
    if (wasChoosingAvatar.current && !choosingAvatar)
      avatarButton.current?.focus();
    wasChoosingAvatar.current = choosingAvatar;
  }, [choosingAvatar]);
  const save = useMutation({
    mutationFn: () => {
      const input = {
        name: name.trim(),
        systemPrompt: description.trim() || "Help me with my everyday work.",
        avatarId,
        ...(inferenceChanged && selection ? { inference: selection } : {}),
      };
      return agent
        ? directory.update(agent.id, input)
        : directory.create(input);
    },
    onSuccess: async () => {
      await cache.invalidateQueries({ queryKey: ["agents", profile?.subject] });
      onSaved(agent ? "Teammate updated." : "Teammate created.");
      onClose();
    },
  });
  /** Reject incomplete names or model settings and prevent duplicate submissions. */
  function submit(event: FormEvent<HTMLFormElement>): void {
    event.preventDefault();
    if (name.trim() && inferenceReady && !save.isPending) save.mutate();
  }
  /** Return from artwork selection without discarding the profile draft. */
  function close(): void {
    if (save.isPending) return;
    if (choosingAvatar) setChoosingAvatar(false);
    else onClose();
  }
  return (
    <Dialog
      title={
        choosingAvatar
          ? "Choose an avatar"
          : agent
            ? "Edit teammate"
            : "Create a new teammate"
      }
      description={
        choosingAvatar
          ? "Pick a character for your teammate."
          : "Choose your teammate’s profile and model settings. You can change them later."
      }
      className={`teammate-editor ${choosingAvatar ? "choosing-avatar" : ""}`}
      onClose={close}
      footer={
        <div className="dialog-actions teammate-editor-actions">
          <Button variant="light" disabled={save.isPending} onClick={close}>
            {choosingAvatar ? "Back" : "Cancel"}
          </Button>
          {/* Distinct controls prevent the avatar click from becoming a native form submission after rerender. */}
          {choosingAvatar ? (
            <Button
              key="confirm-avatar"
              onClick={() => {
                setAvatarId(avatarChoice);
                setChoosingAvatar(false);
              }}
            >
              Use avatar
            </Button>
          ) : (
            <Button
              key="save-profile"
              form={formId}
              type="submit"
              disabled={!name.trim() || !inferenceReady || save.isPending}
            >
              {save.isPending
                ? "Saving…"
                : agent
                  ? "Save changes"
                  : "Create teammate"}
            </Button>
          )}
        </div>
      }
    >
      {choosingAvatar ? (
        <AvatarPicker value={avatarChoice} onChange={setAvatarChoice} />
      ) : (
        <form id={formId} onSubmit={submit} aria-busy={save.isPending}>
          <div className="teammate-avatar-field">
            <TeammateAvatar avatarId={avatarId} />
            <span className="eyebrow">Avatar</span>
            <Button
              ref={avatarButton}
              variant="light"
              disabled={save.isPending}
              onClick={() => {
                setAvatarChoice(avatarId);
                setChoosingAvatar(true);
              }}
            >
              Change avatar
            </Button>
          </div>
          <label className="field">
            Teammate name
            <input
              autoFocus
              required
              maxLength={agentLimits.nameLength}
              placeholder="e.g. Research assistant"
              value={name}
              onChange={(event) => setName(event.target.value)}
              disabled={save.isPending}
            />
          </label>
          <label className="field">
            Description <span className="muted">(optional)</span>
            <textarea
              rows={3}
              maxLength={agentLimits.systemPromptLength}
              placeholder="Describe what your teammate should help with."
              value={description}
              onChange={(event) => setDescription(event.target.value)}
              disabled={save.isPending}
            />
            <small>Leave blank for general help with everyday tasks.</small>
          </label>
          <InferenceFields
            value={inference}
            saved={agent?.inference ?? null}
            required={!agent}
            disabled={save.isPending}
            onChange={setInference}
            onValidityChange={setValidInference}
          />
          {save.isError && (
            <p className="form-error" role="alert">
              {save.error.message}
            </p>
          )}
        </form>
      )}
    </Dialog>
  );
}
