import { useEffect, useState } from "react";
import { Button } from "@everything/ui/button";
import { ConfirmationDialog } from "@everything/ui/confirmation-dialog";
import {
  useStartUpgrade,
  useUpgradeStatus,
} from "./installation-upgrades-provider.js";
import { presentUpgrade } from "../model/upgrade-presentation.js";

/** The installed version, a newer one to upgrade to, and the progress of an upgrade. */
export function VersionSettings() {
  const status = useUpgradeStatus();
  const start = useStartUpgrade();
  const [confirming, setConfirming] = useState<string | null>(null);
  const [followed, setFollowed] = useState<string | null>(null);
  const running =
    status.data?.lastUpgrade?.state === "running"
      ? status.data.lastUpgrade.toVersion
      : null;
  useEffect(() => {
    if (running) setFollowed(running);
  }, [running]);

  if (status.isPending)
    return (
      <p className="settings-status" role="status">
        Checking for a new version…
      </p>
    );
  if (!status.data)
    return (
      <div className="settings-status" role="alert">
        <p>
          Couldn’t check for a new version right now. Try again in a moment.
        </p>
        <Button variant="light" onClick={() => void status.refetch()}>
          Try again
        </Button>
      </div>
    );

  const current = status.data.currentVersion;
  const { offer, notice } = presentUpgrade(status.data, followed);
  if (offer.kind === "running")
    return (
      <div className="settings-status" role="status" aria-live="polite">
        <p className="version-headline">
          Upgrading to version {offer.version}…
        </p>
        <p>
          {status.isError
            ? "Everything is restarting. This page reconnects when it’s back."
            : "Everything restarts during the upgrade, which takes a few minutes. This page keeps checking until it’s done."}
        </p>
      </div>
    );

  return (
    <div className="settings-status">
      {notice?.kind === "upgraded" && (
        <div className="version-notice" role="status">
          <p>
            Everything is now on version {notice.version}. Reload the page to
            use it.
          </p>
          <Button variant="light" onClick={() => window.location.reload()}>
            Reload
          </Button>
        </div>
      )}
      {notice?.kind === "failed" && (
        <div className="version-notice" role="alert">
          <p>
            The upgrade to version {notice.version} didn’t finish, so Everything
            stayed on version {current}.
          </p>
          <pre className="version-failure">{notice.reason}</pre>
        </div>
      )}
      {offer.kind === "available" && (
        <>
          <p>
            Version {offer.version} is available. You’re on version {current}.
          </p>
          <Button onClick={() => setConfirming(offer.version)}>
            Upgrade to {offer.version}
          </Button>
        </>
      )}
      {offer.kind === "current" && (
        <p>You’re on the newest version, {current}.</p>
      )}
      {offer.kind === "unchecked" && (
        <>
          <p>
            You’re on version {current}. Couldn’t check for a new version right
            now.
          </p>
          <Button variant="light" onClick={() => void status.refetch()}>
            Try again
          </Button>
        </>
      )}
      {offer.kind === "installer" && (
        <p>
          You’re on version {current}. This installation is upgraded with the
          installer.
        </p>
      )}
      {offer.kind === "needs-installer" && (
        <p>
          You’re on version {current}. Run the installer once more to let
          Everything upgrade itself from here.
        </p>
      )}
      {confirming && (
        <ConfirmationDialog
          title={`Upgrade to ${confirming}?`}
          description={`Everything restarts during the upgrade, which takes a few minutes, and teammates stop what they’re working on until it’s back. If the new version doesn’t start, Everything returns to version ${current}.`}
          confirmLabel="Upgrade"
          pendingLabel="Starting…"
          pending={start.isPending}
          {...(start.isError
            ? {
                error:
                  "Couldn’t start the upgrade. Check for new versions and try again.",
              }
            : {})}
          onCancel={() => {
            start.reset();
            setConfirming(null);
          }}
          onConfirm={() =>
            start.mutate(confirming, {
              onSuccess: () => setConfirming(null),
              onError: () => void status.refetch(),
            })
          }
        />
      )}
    </div>
  );
}
