import { useCallback, useSyncExternalStore } from "react";
import { useSession } from "../../session/component/session-provider.js";
import type { DesktopNotificationPermission } from "../interface/desktop-notifications.js";
import { useDesktopNotificationServices } from "../component/desktop-notification-provider.js";

/** Follow the browser's permission, including changes made in its site settings. */
export function useNotificationPermission(): DesktopNotificationPermission {
  const { notifications } = useDesktopNotificationServices();
  const subscribe = useCallback(
    (listener: () => void) => notifications.subscribe(listener),
    [notifications],
  );
  return useSyncExternalStore(
    subscribe,
    () => notifications.permission(),
    () => "unsupported" as const,
  );
}

/** Follow the signed-in user's choice for this device, including changes made in another tab. */
export function useNotificationPreference(): boolean {
  const { preferences } = useDesktopNotificationServices();
  const { profile } = useSession();
  const subscribe = useCallback(
    (listener: () => void) => preferences.subscribe(listener),
    [preferences],
  );
  return useSyncExternalStore(
    subscribe,
    () => (profile ? preferences.enabled(profile.subject) : false),
    () => false,
  );
}

/** Whether this tab should notify: the user turned notifications on and the browser allows them. */
export function useNotificationsEnabled(): boolean {
  const permission = useNotificationPermission();
  const preferred = useNotificationPreference();
  return permission === "granted" && preferred;
}
