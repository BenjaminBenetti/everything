import { useEffect, useId, useRef, useState } from "react";
import { Check, Copy, KeyRound } from "lucide-react";
import { IconButton } from "@everything/ui/button";
import { useArtifactLibrary } from "./artifact-library-provider.js";

/** What the reveal shows while it is open. */
type Reveal =
  | { readonly state: "loading" }
  | { readonly state: "shown"; readonly apiKey: string }
  | { readonly state: "failed" };

/**
 * Show a dynamic app's API key on hover, keyboard focus, or tap. The key is requested each time it
 * opens and kept only in this component's state until it closes.
 */
export function ArtifactApiKey({
  appId,
  title,
}: {
  appId: string;
  title: string;
}) {
  const library = useArtifactLibrary();
  const id = useId();
  const root = useRef<HTMLSpanElement>(null);
  const trigger = useRef<HTMLButtonElement>(null);
  const [open, setOpen] = useState(false);
  const [reveal, setReveal] = useState<Reveal>({ state: "loading" });
  const [copied, setCopied] = useState(false);

  useEffect(() => {
    if (!open) return;
    const request = new AbortController();
    library.apiKey(appId, request.signal).then(
      (apiKey) => {
        if (!request.signal.aborted) setReveal({ state: "shown", apiKey });
      },
      () => {
        if (!request.signal.aborted) setReveal({ state: "failed" });
      },
    );
    return () => {
      request.abort();
      setReveal({ state: "loading" });
      setCopied(false);
    };
  }, [open, appId, library]);

  useEffect(() => {
    if (!open) return;
    /** Close when a click or tap lands anywhere else on the page. */
    const closeOutside = (event: PointerEvent) => {
      if (!root.current?.contains(event.target as Node)) setOpen(false);
    };
    document.addEventListener("pointerdown", closeOutside);
    return () => document.removeEventListener("pointerdown", closeOutside);
  }, [open]);

  /** Copy the shown key; if the browser refuses, the key stays selectable. */
  async function copy(apiKey: string): Promise<void> {
    try {
      await navigator.clipboard.writeText(apiKey);
      setCopied(true);
    } catch {
      setCopied(false);
    }
  }

  return (
    <span
      ref={root}
      className="artifact-indicator artifact-api-key"
      onMouseEnter={() => setOpen(true)}
      onMouseLeave={(event) => {
        if (!event.currentTarget.contains(document.activeElement))
          setOpen(false);
      }}
      onBlur={(event) => {
        if (!event.currentTarget.contains(event.relatedTarget)) setOpen(false);
      }}
      onKeyDown={(event) => {
        if (event.key !== "Escape" || !open) return;
        event.stopPropagation();
        setOpen(false);
        trigger.current?.focus();
      }}
    >
      <button
        ref={trigger}
        type="button"
        className="artifact-indicator-icon artifact-api-key-trigger"
        aria-label={`API Key for ${title}`}
        aria-expanded={open}
        aria-controls={open ? id : undefined}
        onFocus={() => setOpen(true)}
        onClick={() => setOpen(true)}
      >
        <KeyRound aria-hidden="true" />
      </button>
      {open && (
        <span id={id} className="artifact-tooltip artifact-api-key-panel">
          <span className="artifact-api-key-title">API Key</span>
          <span>
            External services can call this app by sending this key in an
            X-Api-Key header.
          </span>
          {reveal.state === "shown" ? (
            <span className="artifact-api-key-value">
              <code>{reveal.apiKey}</code>
              <IconButton
                label={copied ? "Copied" : "Copy API key"}
                onClick={() => void copy(reveal.apiKey)}
              >
                {copied ? (
                  <Check aria-hidden="true" />
                ) : (
                  <Copy aria-hidden="true" />
                )}
              </IconButton>
            </span>
          ) : reveal.state === "failed" ? (
            <span className="form-error">
              The API key isn’t available right now. Try again in a moment.
            </span>
          ) : (
            <span>Loading the key…</span>
          )}
        </span>
      )}
    </span>
  );
}
