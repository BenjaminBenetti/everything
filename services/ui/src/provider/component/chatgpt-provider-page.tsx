import {
  useEffect,
  useRef,
  useState,
  type FormEvent,
  type MouseEvent,
} from "react";
import { ExternalLink } from "lucide-react";
import { Button } from "@everything/ui/button";
import {
  providerLimits,
  type ProviderAuthorization,
  type ProviderConnection,
} from "@everything/provider-contracts";
import { useSession } from "../../session/component/session-provider.js";
import { ConnectionStatus } from "./connection-status.js";
import { ConnectionCheckDetails } from "./connection-check-details.js";
import {
  useProviderAction,
  useProviderConnections,
} from "./provider-connections-context.js";

/** Present ChatGPT sign-in on its own page while all account tokens remain on the server. */
export function ChatGptProviderPage({
  connection,
}: {
  connection: ProviderConnection;
}) {
  const connections = useProviderConnections();
  const action = useProviderAction("chatgpt");
  const { profile } = useSession();
  const storageKey = "everything.chatgpt.authorization." + profile?.subject;
  const [callback, setCallback] = useState("");
  const [waiting, setWaiting] = useState(
    () => sessionStorage.getItem(storageKey) !== null,
  );
  const [notice, setNotice] = useState("");
  const [authorization, setAuthorization] =
    useState<ProviderAuthorization | null>(null);
  const [preparing, setPreparing] = useState(false);
  const [preparationError, setPreparationError] = useState("");
  const signInLink = useRef<HTMLAnchorElement>(null);
  const handled = useRef(false);

  /** Require state saved in this browser as well as the server's owner-bound OAuth attempt. */
  async function finish(address: string): Promise<void> {
    const pending = JSON.parse(
      sessionStorage.getItem(storageKey) ?? "null",
    ) as { state: string; expiresAt: string } | null;
    let returned: URL;
    try {
      returned = new URL(address);
    } catch {
      throw new Error(
        "Paste the complete return address from the ChatGPT sign-in tab.",
      );
    }
    if (
      !pending ||
      new Date(pending.expiresAt).getTime() <= Date.now() ||
      returned.searchParams.get("state") !== pending.state
    )
      throw new Error(
        "This sign-in did not start in this browser or has expired. Continue with ChatGPT again.",
      );
    sessionStorage.removeItem(storageKey);
    setAuthorization(null);
    setWaiting(false);
    setCallback("");
    await connections.complete(address);
  }

  useEffect(() => {
    if (handled.current) return;
    handled.current = true;
    const address = new URLSearchParams(location.hash.slice(1)).get("chatgpt");
    if (!address) {
      void prepareAuthorization();
      return;
    }
    history.replaceState(null, "", location.pathname + location.search);
    action.mutate(() => finish(address));
  }, []);

  useEffect(() => {
    if (!authorization) return;
    signInLink.current?.focus();
    const timeout = window.setTimeout(
      () => setAuthorization(null),
      Math.max(0, new Date(authorization.expiresAt).getTime() - Date.now()),
    );
    return () => window.clearTimeout(timeout);
  }, [authorization]);

  /** Prepare the full authorization URL before rendering a link that can be copied. */
  async function prepareAuthorization(): Promise<void> {
    setPreparing(true);
    setPreparationError("");
    try {
      const next = await connections.authorize();
      sessionStorage.setItem(
        storageKey,
        JSON.stringify({
          state: new URL(next.url).searchParams.get("state"),
          expiresAt: next.expiresAt,
        }),
      );
      setAuthorization(next);
    } catch (error) {
      setPreparationError(
        error instanceof Error
          ? error.message
          : "The sign-in link couldn’t load. Please try again.",
      );
    } finally {
      setPreparing(false);
    }
  }

  /** Preserve the existing new-tab flow while right-click and modified clicks use the real href. */
  function connect(event: MouseEvent<HTMLAnchorElement>): void {
    if (!authorization || action.isPending) {
      event.preventDefault();
      return;
    }
    setWaiting(true);
    setNotice("");
    if (event.metaKey || event.ctrlKey || event.shiftKey || event.altKey)
      return;
    event.preventDefault();
    const popup = window.open("about:blank", "_blank");
    if (popup) {
      popup.sessionStorage.setItem(
        storageKey,
        sessionStorage.getItem(storageKey)!,
      );
      popup.location.href = authorization.url;
    } else location.assign(authorization.url);
  }

  /** Allow a remote browser to submit its loopback return address without exposing account tokens. */
  function submit(event: FormEvent<HTMLFormElement>): void {
    event.preventDefault();
    if (!action.isPending) action.mutate(() => finish(callback));
  }

  return (
    <section className="connection-page" aria-label="ChatGPT">
      <ConnectionStatus connection={connection} pending={action.isPending} />
      {connection.account && (
        <p className="connection-detail">
          {connection.account}
          {connection.status === "verified" ? " · Using ChatGPT plan" : ""}
        </p>
      )}
      <ConnectionCheckDetails connection={connection} />
      <div className="connection-actions">
        {authorization ? (
          <a
            ref={signInLink}
            className="button primary"
            href={authorization.url}
            onClick={connect}
            onContextMenu={() => setWaiting(true)}
            aria-disabled={action.isPending || undefined}
          >
            {connection.configured
              ? "Reconnect ChatGPT"
              : "Continue with ChatGPT"}
          </a>
        ) : (
          <Button
            disabled={preparing || action.isPending}
            onClick={() => void prepareAuthorization()}
          >
            {preparing ? "Preparing sign-in…" : "Get sign-in link"}
          </Button>
        )}
        {connection.configured && (
          <>
            <Button
              variant="light"
              disabled={action.isPending}
              onClick={() => action.mutate(() => connections.verify("chatgpt"))}
            >
              Check connection
            </Button>
            <Button
              variant="danger-quiet"
              disabled={action.isPending}
              onClick={() =>
                action.mutate(async () => {
                  const result = await connections.disconnect("chatgpt");
                  sessionStorage.removeItem(storageKey);
                  setAuthorization(null);
                  setWaiting(false);
                  setNotice(result.message ?? "");
                })
              }
            >
              Disconnect
            </Button>
          </>
        )}
      </div>
      {waiting && !action.isPending && (
        <div className="connection-return">
          <p>Finish sign-in in the other tab.</p>
          <details>
            <summary>Sign-in didn’t return here?</summary>
            <p>
              If the return page cannot open, copy its full address from the
              browser and paste it here.
            </p>
            <form onSubmit={submit}>
              <label className="field">
                Return address
                <input
                  type="url"
                  required
                  value={callback}
                  maxLength={providerLimits.callbackLength}
                  placeholder="http://127.0.0.1:8080/…"
                  onChange={(event) => setCallback(event.target.value)}
                  autoComplete="off"
                  spellCheck={false}
                />
              </label>
              <Button
                type="submit"
                disabled={!callback.trim() || action.isPending}
              >
                Finish connection
              </Button>
            </form>
          </details>
        </div>
      )}
      {(preparationError || action.isError || connection.message) && (
        <p className="form-error" role="alert">
          {preparationError || action.error?.message || connection.message}
        </p>
      )}
      {notice && (
        <p className="connection-detail" role="status">
          {notice}
        </p>
      )}
      <a
        className="connection-usage text-link"
        href="https://chatgpt.com/settings/usage"
        target="_blank"
        rel="noreferrer"
      >
        Manage ChatGPT usage <ExternalLink aria-hidden="true" />
      </a>
    </section>
  );
}
