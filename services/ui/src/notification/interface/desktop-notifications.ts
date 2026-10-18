/** Whether this browser can show desktop notifications, and what the user has allowed. */
export type DesktopNotificationPermission =
  "unsupported" | "default" | "denied" | "granted";

/** What one desktop notification shows and does, in plain text the system displays as written. */
export interface DesktopNotificationContent {
  readonly title: string;
  readonly body: string;
  /** Replaces an earlier notification with the same tag instead of stacking a duplicate. */
  readonly tag: string;
  readonly icon?: string;
  /** Runs when the user clicks the notification; the notification closes afterward. */
  readonly onClick: () => void;
}

/** A notification currently on screen. */
export interface ShownDesktopNotification {
  close(): void;
}

/** The browser's notification capability, independent of the Notifications API. */
export interface DesktopNotifications {
  /** The current permission; phones, tablets, and browsers without support are "unsupported". */
  permission(): DesktopNotificationPermission;
  /** Ask the browser for permission. Call only from a user gesture, such as turning on a switch. */
  requestPermission(): Promise<DesktopNotificationPermission>;
  /** Show a notification now; throws when the browser refuses to create it. */
  show(content: DesktopNotificationContent): ShownDesktopNotification;
  /** Follow permission changes made in browser settings; returns an unsubscribe function. */
  subscribe(listener: () => void): () => void;
}
