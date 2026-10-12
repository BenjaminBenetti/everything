import { useState, type FormEvent } from "react";
import { Button } from "@everything/ui/button";
import {
  providerLimits,
  type ApiKeyProviderId,
  type ProviderConnection,
} from "@everything/provider-contracts";
import { providerOptions } from "../model/provider-options.js";
import { ConnectionStatus } from "./connection-status.js";
import { ConnectionCheckDetails } from "./connection-check-details.js";
import {
  useProviderAction,
  useProviderConnections,
} from "./provider-connections-context.js";

/** Open API-key settings directly, with write-only credentials and one save-and-check action. */
export function ApiKeyProviderPage({
  connection,
  provider,
}: {
  connection: ProviderConnection;
  provider: ApiKeyProviderId;
}) {
  const compatible = provider === "openai-compatible";
  const [apiKey, setApiKey] = useState("");
  const [baseUrl, setBaseUrl] = useState(connection.baseUrl ?? "");
  const [model, setModel] = useState(connection.model ?? "");
  const connections = useProviderConnections();
  const action = useProviderAction(provider);
  const changedAddress =
    compatible && baseUrl.trim().replace(/\/+$/, "") !== connection.baseUrl;

  /** Preserve a saved key only when its destination stays the same. */
  function submit(event: FormEvent<HTMLFormElement>): void {
    event.preventDefault();
    if (action.isPending) return;
    action.mutate(async () => {
      await connections.save(provider, {
        ...(apiKey || !connection.configured || changedAddress
          ? { apiKey }
          : {}),
        ...(compatible ? { baseUrl: baseUrl.trim() } : {}),
        model: model.trim(),
      });
      setApiKey("");
    });
  }

  return (
    <section
      className="connection-page"
      aria-label={providerOptions[provider].title}
    >
      <ConnectionStatus connection={connection} pending={action.isPending} />
      <ConnectionCheckDetails connection={connection} />
      <form
        onSubmit={submit}
        className="connection-form"
        aria-busy={action.isPending}
      >
        {compatible && (
          <label className="field">
            API base address
            <input
              autoFocus
              type="url"
              required
              value={baseUrl}
              maxLength={providerLimits.addressLength}
              placeholder="http://your-model-server:11434/v1"
              onChange={(event) => setBaseUrl(event.target.value)}
              disabled={action.isPending}
            />
            <small>
              Use an address reachable from Everything, including /v1 if your
              server needs it.
            </small>
          </label>
        )}
        <label className="field">
          API key{" "}
          {compatible && (
            <span className="muted">(optional for local servers)</span>
          )}
          <input
            autoFocus={!compatible}
            type="password"
            autoComplete="new-password"
            spellCheck={false}
            value={apiKey}
            maxLength={providerLimits.apiKeyLength}
            required={!compatible && !connection.configured}
            placeholder={
              connection.configured && !changedAddress
                ? "Saved securely · leave blank to keep"
                : "Enter API key"
            }
            onChange={(event) => setApiKey(event.target.value)}
            disabled={action.isPending}
          />
        </label>
        <details className="connection-advanced">
          <summary>Advanced settings</summary>
          <label className="field">
            Model name <span className="muted">(optional)</span>
            <input
              value={model}
              maxLength={providerLimits.modelLength}
              placeholder="Choose automatically"
              onChange={(event) => setModel(event.target.value)}
              disabled={action.isPending}
            />
            <small>
              Set this if your server cannot list models or you want to check a
              specific model.
            </small>
          </label>
        </details>
        <div className="connection-actions">
          <Button type="submit" disabled={action.isPending}>
            {action.isPending ? "Checking…" : "Save and check"}
          </Button>
          {connection.configured && (
            <Button
              variant="danger-quiet"
              disabled={action.isPending}
              onClick={() =>
                action.mutate(async () => {
                  await connections.disconnect(provider);
                  setApiKey("");
                })
              }
            >
              Disconnect
            </Button>
          )}
        </div>
      </form>
      {(action.isError || connection.message) && (
        <p className="form-error" role="alert">
          {action.error?.message ?? connection.message}
        </p>
      )}
    </section>
  );
}
