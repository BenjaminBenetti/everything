import type {
  DesktopNotificationContent,
  DesktopNotificationPermission,
  DesktopNotifications,
  ShownDesktopNotification,
} from "../interface/desktop-notifications.js";

/** The part of the Notifications API this adapter uses. */
export interface NotificationApi {
  readonly permission: NotificationPermission;
  requestPermission(): Promise<NotificationPermission>;
  new (
    title: string,
    options?: NotificationOptions,
  ): Pick<Notification, "onclick" | "close">;
}

/** The browser globals the adapter reads, supplied explicitly so tests can describe any browser. */
export interface NotificationEnvironment {
  readonly Notification: NotificationApi | undefined;
  readonly navigator: {
    readonly userAgent: string;
    readonly maxTouchPoints: number;
    readonly userAgentData?: { readonly mobile?: boolean };
    readonly permissions?: Pick<Permissions, "query">;
  };
  readonly isSecureContext: boolean;
  matchMedia(query: string): { readonly matches: boolean };
  /** Receives window focus, when permission changed in settings may have changed. */
  readonly events: EventTarget;
}

/** Read the real browser's globals. */
export function browserNotificationEnvironment(): NotificationEnvironment {
  return {
    Notification: "Notification" in window ? window.Notification : undefined,
    navigator,
    isSecureContext: window.isSecureContext,
    matchMedia: (query) => window.matchMedia(query),
    events: window,
  };
}

/**
 * Show desktop notifications through the browser's Notifications API. Phones and tablets are
 * unsupported, even when they expose the API, because their notifications need push delivery.
 */
export class BrowserDesktopNotifications implements DesktopNotifications {
  // ===========================================
  // Construction
  // ===========================================

  /** Use the real browser unless a test describes another one. */
  constructor(
    private readonly environment: NotificationEnvironment = browserNotificationEnvironment(),
  ) {}

  // ===========================================
  // Permission
  // ===========================================

  /** Report the browser's permission, or "unsupported" where desktop notifications can't work. */
  permission(): DesktopNotificationPermission {
    const api = this.environment.Notification;
    if (!api || !this.environment.isSecureContext || this.isPhoneOrTablet())
      return "unsupported";
    const permission = api.permission;
    return permission === "granted" || permission === "denied"
      ? permission
      : "default";
  }

  /** Ask once from the caller's user gesture, then report the browser's resulting permission. */
  async requestPermission(): Promise<DesktopNotificationPermission> {
    const api = this.environment.Notification;
    if (!api || this.permission() === "unsupported") return "unsupported";
    await api.requestPermission();
    return this.permission();
  }

  /** Notify on permission changes and on returning to the window, when site settings may have changed. */
  subscribe(listener: () => void): () => void {
    let stopped = false;
    let status: PermissionStatus | undefined;
    this.environment.events.addEventListener("focus", listener);
    void this.environment.navigator.permissions
      ?.query({ name: "notifications" })
      .then((result) => {
        if (stopped) return;
        status = result;
        status.addEventListener("change", listener);
      })
      .catch(() => undefined);
    return () => {
      stopped = true;
      this.environment.events.removeEventListener("focus", listener);
      status?.removeEventListener("change", listener);
    };
  }

  // ===========================================
  // Delivery
  // ===========================================

  /** Create a notification that runs its action and closes when clicked. */
  show(content: DesktopNotificationContent): ShownDesktopNotification {
    const api = this.environment.Notification;
    if (!api || this.permission() !== "granted")
      throw new Error("Desktop notifications aren't allowed in this browser");
    const notification = new api(content.title, {
      body: content.body,
      tag: content.tag,
      ...(content.icon ? { icon: content.icon } : {}),
    });
    notification.onclick = () => {
      content.onClick();
      notification.close();
    };
    return { close: () => notification.close() };
  }

  // ===========================================
  // Device detection
  // ===========================================

  /** Recognize phones and tablets, including iPads that report a desktop Safari user agent. */
  private isPhoneOrTablet(): boolean {
    const { navigator } = this.environment;
    if (navigator.userAgentData?.mobile) return true;
    if (/Android|iPhone|iPad|iPod|Mobi/i.test(navigator.userAgent)) return true;
    if (/Macintosh/.test(navigator.userAgent) && navigator.maxTouchPoints > 1)
      return true;
    return this.environment.matchMedia("(hover: none) and (pointer: coarse)")
      .matches;
  }
}
