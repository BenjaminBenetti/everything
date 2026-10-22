import type {
  CredentialUsage,
  CredentialUse,
} from "@everything/artifact-contracts/credential";
import { Button } from "@everything/ui/button";
import { credentialStatusLabels } from "../../artifact/model/credential-presentation.js";

/** Load state of a credential's usage, as the dialogs that show it receive it. */
export interface UsageState {
  readonly data?: CredentialUsage | undefined;
  readonly isPending: boolean;
  readonly isError: boolean;
}

/**
 * List the user's apps that receive a credential, with the variable and status of each, and count
 * other accounts' apps without naming them. No value is ever part of this list.
 */
export function CredentialUsageList({
  usage,
  empty,
  onRemove,
}: {
  usage: UsageState;
  /** Shown when no app receives the credential. */
  empty: string;
  /** Offer to take the credential away from one app. */
  onRemove?: (use: CredentialUse) => void;
}) {
  if (usage.isPending)
    return (
      <p className="muted" role="status">
        Checking which apps use it…
      </p>
    );
  if (usage.isError || !usage.data)
    return (
      <p className="form-error" role="alert">
        Apps that use it couldn’t be checked right now. Try again in a moment.
      </p>
    );
  const { apps, otherApps } = usage.data;
  if (!apps.length && !otherApps) return <p className="muted">{empty}</p>;
  return (
    <>
      {!!apps.length && (
        <ul className="credential-usage" aria-label="Apps that use it">
          {apps.map((use) => (
            <li key={`${use.appId}:${use.env}`}>
              <span className="credential-usage-app">
                <strong>{use.title}</strong>
                <code>{use.env}</code>
              </span>
              <span
                className={`credential-status credential-status-${use.status}`}
              >
                {credentialStatusLabels[use.status]}
              </span>
              {onRemove && use.status !== "removing" && (
                <Button
                  variant="light"
                  aria-label={`Remove from ${use.title}`}
                  onClick={(event) => {
                    event.currentTarget.setAttribute("data-dialog-return", "");
                    onRemove(use);
                  }}
                >
                  Remove
                </Button>
              )}
            </li>
          ))}
        </ul>
      )}
      {otherApps > 0 && (
        <p className="muted">
          {otherApps === 1
            ? "One app of another account also uses it."
            : `${otherApps} apps of other accounts also use it.`}
        </p>
      )}
    </>
  );
}
