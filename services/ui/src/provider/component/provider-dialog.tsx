import { useRef, useState } from "react";
import { ArrowLeft } from "lucide-react";
import type { ProviderId } from "@everything/provider-contracts";
import { Button } from "@everything/ui/button";
import { Dialog } from "@everything/ui/dialog";
import { providerOptions } from "../model/provider-options.js";
import { useProviders } from "./provider-connections-context.js";
import { ApiKeyProviderPage } from "./api-key-provider-page.js";
import { ChatGptProviderPage } from "./chatgpt-provider-page.js";
import { ProviderPicker } from "./provider-picker.js";

/** Navigate from a compact provider list to one focused setup page within the same dialog. */
export function ProviderDialog({ onClose }: { onClose: () => void }) {
  const providers = useProviders();
  const [selected, setSelected] = useState<ProviderId | null>(() =>
    new URLSearchParams(location.hash.slice(1)).has("chatgpt")
      ? "chatgpt"
      : null,
  );
  const previousSelection = useRef<ProviderId | null>(null);
  const option = selected ? providerOptions[selected] : null;
  const connection = providers.data?.find((item) => item.provider === selected);

  /** Remember the originating choice for keyboard focus when returning to the list. */
  function select(provider: ProviderId): void {
    previousSelection.current = provider;
    setSelected(provider);
  }

  return (
    <Dialog
      title={option?.title ?? "Model providers"}
      description={
        option?.description ?? "Choose a provider for your teammates."
      }
      className="provider-dialog"
      onClose={onClose}
    >
      {selected && (
        <Button
          className="provider-back"
          variant="text"
          onClick={() => setSelected(null)}
        >
          <ArrowLeft aria-hidden="true" /> Back
        </Button>
      )}
      {providers.isPending && <p role="status">Loading connections…</p>}
      {providers.isError && (
        <div role="alert">
          <p>Connections couldn’t load.</p>
          <Button variant="light" onClick={() => void providers.refetch()}>
            Try again
          </Button>
        </div>
      )}
      {!selected && providers.data && (
        <ProviderPicker
          connections={providers.data}
          focusProvider={previousSelection.current}
          onSelect={select}
        />
      )}
      {connection && (
        <>
          {connection.provider === "chatgpt" ? (
            <ChatGptProviderPage connection={connection} />
          ) : (
            <ApiKeyProviderPage
              key={connection.provider}
              connection={connection}
              provider={connection.provider}
            />
          )}
          <p className="provider-check-note">
            Checks send a short test request and may use provider credits.
            Credentials are saved securely.
          </p>
        </>
      )}
    </Dialog>
  );
}
