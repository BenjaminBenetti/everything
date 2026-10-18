import { useCallback, useState, useSyncExternalStore } from "react";
import { useSession } from "../../session/component/session-provider.js";
import { useDesktopNotificationServices } from "../component/desktop-notification-provider.js";
import type { PermissionRequest } from "../model/notification-status.js";
import {
  useNotificationPermission,
  useNotificationPreference,
} from "./use-desktop-notification-state.js";

/** The desktop notification switch: the browser's permission, the user's choice, and changing it. */
export function useDesktopNotificationSettings() {
  const { notifications, preferences, notifier } =
    useDesktopNotificationServices();
  const { profile } = useSession();
  const permission = useNotificationPermission();
  const preferred = useNotificationPreference();
  const subscribe = useCallback(
    (listener: () => void) => notifier.subscribe(listener),
    [notifier],
  );
  const deliveryFailed = useSyncExternalStore(
    subscribe,
    () => notifier.deliveryFailed,
    () => false,
  );
  const [request, setRequest] = useState<PermissionRequest>("idle");

  /**
   * Turn notifications on or off. Turning them on asks the browser first when it hasn't decided;
   * this must run from the user's click, the only time browsers allow asking.
   */
  function change(checked: boolean): void {
    if (!profile) return;
    const subject = profile.subject;
    if (!checked || permission === "granted") {
      setRequest("idle");
      preferences.setEnabled(subject, checked);
      return;
    }
    if (permission !== "default") return;
    setRequest("pending");
    notifications.requestPermission().then(
      (result) => {
        if (result === "granted") preferences.setEnabled(subject, true);
        setRequest(result === "default" ? "dismissed" : "idle");
      },
      () => setRequest("failed"),
    );
  }

  return {
    permission,
    /** On only while the user chose it and the browser still allows it. */
    enabled: permission === "granted" && preferred,
    request,
    deliveryFailed,
    change,
  };
}
