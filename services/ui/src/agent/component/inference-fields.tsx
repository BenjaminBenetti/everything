import { useEffect, useId } from "react";
import { ChevronRight } from "lucide-react";
import { useQuery } from "@tanstack/react-query";
import type { ProviderId } from "@everything/provider-contracts";
import {
  isActiveProvider,
  type InferenceEffort,
  type InferenceSelection,
} from "@everything/provider-contracts/inference";
import { Button } from "@everything/ui/button";
import { Select } from "@everything/ui/select";
import {
  useProviderConnections,
  useProviders,
} from "../../provider/component/provider-connections-context.js";
import { providerOptions } from "../../provider/model/provider-options.js";
import { useSession } from "../../session/component/session-provider.js";
import { effortLabels } from "../model/inference-options.js";

/** Keep dependent choices in the teammate draft so avatar selection and retries preserve them. */
export interface InferenceDraft {
  readonly provider: ProviderId | "";
  readonly model: string;
  readonly effort: InferenceEffort | "";
}

/** Keep model settings collapsed, explain required selections, and offer active providers and supported settings. */
export function InferenceFields({
  value,
  saved,
  required = false,
  disabled,
  onChange,
  onValidityChange,
}: {
  value: InferenceDraft;
  saved: InferenceSelection | null;
  required?: boolean;
  disabled: boolean;
  onChange: (value: InferenceDraft) => void;
  onValidityChange: (valid: boolean) => void;
}) {
  const fieldId = useId();
  const providers = useProviders();
  const connections = useProviderConnections();
  const { profile } = useSession();
  const active = (providers.data ?? []).filter(isActiveProvider);
  const connection = active.find((item) => item.provider === value.provider);
  const models = useQuery({
    queryKey: [
      "provider-models",
      profile?.subject,
      value.provider,
      connection?.verifiedAt,
      connection?.baseUrl,
    ],
    queryFn: ({ signal }) =>
      connections.models(value.provider as ProviderId, signal),
    enabled: !!connection,
    staleTime: 0,
    retry: false,
  });
  const model = models.data?.find((item) => item.id === value.model);
  const providerName = value.provider
    ? providerOptions[value.provider].title
    : "";
  const modelName = (model?.name ?? value.model) || "Choose a model";
  const effortName =
    value.effort === "off"
      ? "Default"
      : value.effort
        ? effortLabels[value.effort]
        : "";
  const selectionSummary = value.provider
    ? [providerName, modelName, effortName].filter(Boolean).join(" · ")
    : required
      ? "Choose a model (required)"
      : "Not set";
  const valid =
    !!connection &&
    !models.isError &&
    !!model &&
    !!value.effort &&
    model.efforts.includes(value.effort);
  useEffect(() => onValidityChange(valid), [valid, onValidityChange]);
  const unavailable = !!value.provider && !providers.isPending && !connection;

  /** Changing providers clears every dependent setting instead of silently retaining an invalid choice. */
  function changeProvider(provider: ProviderId | ""): void {
    onChange({ provider, model: "", effort: "" });
  }

  /** Use this model's supported default effort when choosing a different model. */
  function changeModel(id: string): void {
    const next = models.data?.find((item) => item.id === id);
    onChange({ ...value, model: id, effort: next?.defaultEffort ?? "" });
  }

  return (
    <details className="teammate-inference">
      <summary className="teammate-inference-summary">
        <span className="teammate-inference-title">Model settings</span>
        <span className="teammate-inference-selection" title={selectionSummary}>
          {value.provider ? (
            <>
              <span className="teammate-inference-value">{providerName}</span>
              <span aria-hidden="true">·</span>
              <span className="teammate-inference-value">{modelName}</span>
              {effortName && (
                <>
                  <span aria-hidden="true">·</span>
                  <span className="teammate-inference-effort">
                    {effortName}
                  </span>
                </>
              )}
            </>
          ) : (
            <span className="teammate-inference-value">{selectionSummary}</span>
          )}
        </span>
        <ChevronRight
          className="teammate-inference-chevron"
          aria-hidden="true"
        />
      </summary>
      <fieldset
        className="teammate-inference-fields"
        aria-label="Model settings"
        disabled={disabled}
      >
        <div className="field">
          <label htmlFor={`${fieldId}-provider`}>Provider</label>
          <Select
            id={`${fieldId}-provider`}
            label="Provider"
            required={required}
            value={connection ? value.provider : ""}
            onValueChange={(provider) =>
              changeProvider(provider as ProviderId | "")
            }
            disabled={disabled || providers.isPending || providers.isError}
            placeholder={
              providers.isPending ? "Loading providers…" : "Choose a provider"
            }
            options={[
              { value: "", label: "Choose a provider" },
              ...active.map((item) => ({
                value: item.provider,
                label: providerOptions[item.provider].title,
              })),
            ]}
          />
        </div>
        {providers.isError ? (
          <p className="form-error" role="alert">
            Could not load providers.{" "}
            <Button variant="light" onClick={() => void providers.refetch()}>
              Try again
            </Button>
          </p>
        ) : (
          !providers.isPending &&
          active.length === 0 && (
            <p className="muted">
              Connect and check a provider in Model providers to choose a model
              for this teammate.
            </p>
          )
        )}
        {unavailable && saved && (
          <p className="form-error" role="status">
            The saved provider, {providerOptions[saved.provider].title}, is
            unavailable. Reconnect it in Model providers or choose another
            provider.
          </p>
        )}
        <div className="field">
          <label htmlFor={`${fieldId}-model`}>Model</label>
          <Select
            id={`${fieldId}-model`}
            label="Model"
            required={required}
            value={model ? value.model : ""}
            onValueChange={changeModel}
            disabled={
              disabled || !connection || models.isPending || models.isError
            }
            placeholder={
              connection && models.isPending
                ? "Loading models…"
                : "Choose a model"
            }
            options={[
              { value: "", label: "Choose a model" },
              ...(models.data ?? []).map((item) => ({
                value: item.id,
                label: item.name,
              })),
            ]}
          />
        </div>
        {connection && models.isError && (
          <p className="form-error" role="alert">
            Could not load models. {models.error.message}{" "}
            <Button variant="light" onClick={() => void models.refetch()}>
              Retry models
            </Button>
          </p>
        )}
        {connection && models.isSuccess && models.data.length === 0 && (
          <p role="status" className="muted">
            This provider has no available models. Check its settings in Model
            providers.
          </p>
        )}
        {connection && models.isSuccess && value.model && !model && (
          <p role="status" className="form-error">
            The saved model is unavailable. Choose another model.
          </p>
        )}
        <div className="field">
          <label htmlFor={`${fieldId}-effort`}>Effort level</label>
          <Select
            id={`${fieldId}-effort`}
            label="Effort level"
            required={required}
            describedBy={`${fieldId}-effort-hint`}
            value={
              model && value.effort && model.efforts.includes(value.effort)
                ? value.effort
                : ""
            }
            onValueChange={(effort) =>
              onChange({
                ...value,
                effort: effort as InferenceEffort | "",
              })
            }
            disabled={disabled || !model || !connection || models.isError}
            placeholder="Choose an effort level"
            options={[
              { value: "", label: "Choose an effort level" },
              ...(model?.efforts ?? []).map((effort) => ({
                value: effort,
                label: effortLabels[effort],
              })),
            ]}
          />
          <small id={`${fieldId}-effort-hint`}>
            {model?.efforts.length === 1 && model.efforts[0] === "off"
              ? "This model does not expose an adjustable effort level."
              : "Higher effort can improve complex work and take more time."}
          </small>
        </div>
      </fieldset>
    </details>
  );
}
