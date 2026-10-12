import { useEffect, useRef } from "react";
import { ChevronRight, KeyRound, Server } from "lucide-react";
import type {
  ProviderConnection,
  ProviderId,
} from "@everything/provider-contracts";
import { providerOptions } from "../model/provider-options.js";
import { ConnectionStatus } from "./connection-status.js";

/** Offer compact provider choices and restore focus when returning from a setup page. */
export function ProviderPicker({
  connections,
  focusProvider,
  onSelect,
}: {
  connections: readonly ProviderConnection[];
  focusProvider: ProviderId | null;
  onSelect: (provider: ProviderId) => void;
}) {
  const previousOption = useRef<HTMLButtonElement>(null);
  useEffect(() => {
    previousOption.current?.focus();
  }, []);
  return (
    <div className="provider-picker">
      {connections.map((connection) => {
        const { title, description } = providerOptions[connection.provider];
        const Icon = connection.provider === "anthropic" ? KeyRound : Server;
        return (
          <button
            key={connection.provider}
            ref={
              connection.provider === focusProvider ? previousOption : undefined
            }
            type="button"
            className="provider-option"
            onClick={() => onSelect(connection.provider)}
          >
            <span className="connection-icon" aria-hidden="true">
              {connection.provider === "chatgpt" ? (
                <span className="chatgpt-logo" />
              ) : (
                <Icon />
              )}
            </span>
            <span className="provider-option-copy">
              <strong>{title}</strong>
              <span className="provider-option-description">{description}</span>
              <ConnectionStatus connection={connection} />
            </span>
            <ChevronRight
              className="provider-option-arrow"
              aria-hidden="true"
            />
          </button>
        );
      })}
    </div>
  );
}
