import { useId, useState, type FormEvent } from "react";
import { useMutation, useQueryClient } from "@tanstack/react-query";
import type { ArtifactSummary } from "@everything/artifact-contracts";
import {
  appCredentialLimits,
  type AppCredential,
} from "@everything/artifact-contracts/credential";
import { Button } from "@everything/ui/button";
import { ConfirmationDialog } from "@everything/ui/confirmation-dialog";
import { Dialog } from "@everything/ui/dialog";
import { Select } from "@everything/ui/select";
import { useKeys } from "../../key/component/key-directory-provider.js";
import { useSession } from "../../session/component/session-provider.js";
import {
  attachableCredentials,
  credentialFailureMessage,
  credentialStatusLabels,
  credentialVariableMessage,
  suggestedVariable,
} from "../model/credential-presentation.js";
import { useArtifactLibrary } from "./artifact-library-provider.js";

/**
 * Manage which of the user's generic credentials a dynamic app's backend receives. Values never
 * pass through the browser here: attaching sends only the credential's ID and a variable name.
 */
export function AppCredentialsDialog({
  artifact,
  onClose,
}: {
  artifact: ArtifactSummary;
  onClose: () => void;
}) {
  const formId = useId();
  const [credentialId, setCredentialId] = useState("");
  const [env, setEnv] = useState("");
  const [touched, setTouched] = useState(false);
  const [removing, setRemoving] = useState<AppCredential | null>(null);
  const library = useArtifactLibrary();
  const keys = useKeys();
  const cache = useQueryClient();
  const { profile } = useSession();
  const attached = artifact.credentials ?? [];
  const choices = attachableCredentials(keys.data ?? []);
  const variableProblem = credentialVariableMessage(env);
  const full = attached.length >= appCredentialLimits.count;

  /** Refresh the app's list and every credential's usage after a change. */
  async function refresh(): Promise<void> {
    await Promise.all([
      cache.invalidateQueries({ queryKey: ["artifacts", profile?.subject] }),
      cache.invalidateQueries({ queryKey: ["keys", profile?.subject] }),
    ]);
  }

  const attach = useMutation({
    mutationFn: () =>
      library.attachCredential(artifact.id, { credentialId, env }),
    onSuccess: async () => {
      setCredentialId("");
      setEnv("");
      setTouched(false);
      await refresh();
    },
  });
  const detach = useMutation({
    mutationFn: (credential: AppCredential) =>
      library.detachCredential(artifact.id, credential.env),
    onSuccess: async () => {
      setRemoving(null);
      await refresh();
    },
  });

  /** Attach only a chosen credential under a valid variable name. */
  function submit(event: FormEvent<HTMLFormElement>): void {
    event.preventDefault();
    setTouched(true);
    if (attach.isPending || !credentialId || variableProblem || full) return;
    attach.mutate();
  }

  return (
    <>
      <Dialog
        title={`Credentials for ${artifact.title}`}
        description="Attached credentials reach this app’s backend as environment variables. Removing one restarts the app without it."
        onClose={onClose}
        dismissible={!attach.isPending}
        className="credential-dialog"
        footer={
          <div className="dialog-actions">
            <Button
              variant="light"
              disabled={attach.isPending}
              onClick={onClose}
            >
              Close
            </Button>
            <Button
              form={formId}
              type="submit"
              disabled={attach.isPending || !credentialId || full}
            >
              {attach.isPending ? "Attaching…" : "Attach credential"}
            </Button>
          </div>
        }
      >
        <div className="credential-dialog-section" aria-live="polite">
          <h3 className="credential-heading">Attached</h3>
          {attached.length ? (
            <ul className="credential-usage" aria-label="Attached credentials">
              {attached.map((credential) => (
                <li key={`${credential.env}:${credential.credentialId}`}>
                  <span className="credential-usage-app">
                    <code>{credential.env}</code>
                    <strong>{credential.name ?? "Deleted credential"}</strong>
                  </span>
                  <span
                    className={`credential-status credential-status-${credential.status}`}
                  >
                    {credentialStatusLabels[credential.status]}
                  </span>
                  {credential.status !== "removing" && (
                    <Button
                      variant="light"
                      aria-label={`Remove ${credential.env}`}
                      onClick={(event) => {
                        event.currentTarget.setAttribute(
                          "data-dialog-return",
                          "",
                        );
                        detach.reset();
                        setRemoving(credential);
                      }}
                    >
                      Remove
                    </Button>
                  )}
                </li>
              ))}
            </ul>
          ) : (
            <p className="muted">No credentials are attached to this app.</p>
          )}
        </div>
        <form
          id={formId}
          className="credential-dialog-section"
          onSubmit={submit}
          aria-busy={attach.isPending}
        >
          <h3 className="credential-heading">Attach a credential</h3>
          {keys.isError ? (
            <p className="form-error" role="alert">
              Your credentials couldn’t be loaded. Close this dialog and try
              again.
            </p>
          ) : choices.length ? (
            <>
              <div className="field">
                <span>Credential</span>
                <Select
                  label="Credential"
                  value={credentialId}
                  options={choices.map((key) => ({
                    value: key.id,
                    label: key.name,
                  }))}
                  placeholder={
                    keys.isPending ? "Loading…" : "Choose a credential"
                  }
                  disabled={attach.isPending || full}
                  onValueChange={(value) => {
                    setCredentialId(value);
                    if (!env) {
                      const chosen = choices.find((key) => key.id === value);
                      if (chosen) setEnv(suggestedVariable(chosen.name));
                    }
                  }}
                />
              </div>
              <label className="field">
                Environment variable
                <input
                  value={env}
                  maxLength={appCredentialLimits.envLength}
                  placeholder="e.g. SLACK_BOT_TOKEN"
                  autoComplete="off"
                  autoCapitalize="characters"
                  spellCheck={false}
                  disabled={attach.isPending || full}
                  aria-invalid={touched && !!variableProblem}
                  onChange={(event) => {
                    setEnv(event.target.value);
                    attach.reset();
                  }}
                  onBlur={() => setTouched(true)}
                />
                {touched && variableProblem && <small>{variableProblem}</small>}
              </label>
            </>
          ) : (
            <p className="muted">
              {keys.isPending
                ? "Loading your credentials…"
                : "You haven’t added a generic credential yet. Add one on the Keys page, then attach it here."}
            </p>
          )}
          <p className="credential-notice" role="note">
            Attaching gives this app’s backend the credential’s value. Its code
            can read the value and send it anywhere, so only attach credentials
            to apps you trust. The value is never given to the app’s pages in
            the browser.
          </p>
          {full && (
            <p className="muted">
              This app already has {appCredentialLimits.count} credentials, the
              most an app can receive.
            </p>
          )}
          {attach.isError && (
            <p className="form-error" role="alert">
              {credentialFailureMessage(attach.error)}
            </p>
          )}
        </form>
      </Dialog>
      {removing && (
        <ConfirmationDialog
          title="Remove credential?"
          description={`“${artifact.title}” stops receiving ${removing.env} and restarts without it.`}
          confirmLabel="Remove credential"
          pendingLabel="Removing…"
          pending={detach.isPending}
          {...(detach.isError
            ? { error: credentialFailureMessage(detach.error) }
            : {})}
          onCancel={() => {
            if (!detach.isPending) setRemoving(null);
          }}
          onConfirm={() => {
            if (!detach.isPending) detach.mutate(removing);
          }}
        />
      )}
    </>
  );
}
