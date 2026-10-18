import type { DesktopNotificationPermission } from "../interface/desktop-notifications.js";

/** Progress of a permission request started from the switch. */
export type PermissionRequest = "idle" | "pending" | "dismissed" | "failed";

/** What the desktop notification switch currently means, and whether it's a problem to act on. */
export interface NotificationStatus {
  readonly message: string;
  /** Problems are announced as alerts; everything else is a polite status. */
  readonly problem: boolean;
}

/** Explain what the switch does now and, when it can't be used, what to do instead. */
export function notificationStatus(
  permission: DesktopNotificationPermission,
  enabled: boolean,
  request: PermissionRequest,
  deliveryFailed: boolean,
): NotificationStatus {
  if (permission === "unsupported")
    return {
      message:
        "This browser can’t show desktop notifications. Open Everything in a desktop browser to use them.",
      problem: false,
    };
  if (permission === "denied")
    return {
      message:
        "Your browser is blocking notifications from Everything. To use them, allow notifications for this site in your browser’s settings.",
      problem: false,
    };
  if (request === "pending")
    return {
      message:
        "Choose Allow in your browser’s prompt to turn on notifications.",
      problem: false,
    };
  if (request === "failed")
    return {
      message:
        "Your browser couldn’t ask for permission. Try again, or allow notifications for this site in your browser’s settings.",
      problem: true,
    };
  if (request === "dismissed" && !enabled)
    return {
      message:
        "Your browser didn’t allow notifications. Turn on the switch to ask again.",
      problem: true,
    };
  if (permission === "default")
    return {
      message: "Your browser will ask for permission when you turn this on.",
      problem: false,
    };
  if (!enabled)
    return {
      message:
        "Your browser allows notifications, but Everything won’t send any on this device until you turn this on.",
      problem: false,
    };
  if (deliveryFailed)
    return {
      message:
        "Your browser couldn’t show the last notification. Check that your computer’s settings allow notifications from your browser.",
      problem: true,
    };
  return {
    message:
      "You’ll get a notification when a teammate sends you a message, unless you’re already looking at their chat.",
    problem: false,
  };
}
