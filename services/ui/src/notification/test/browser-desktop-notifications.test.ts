import assert from "node:assert/strict";
import { test } from "node:test";
import {
  BrowserDesktopNotifications,
  type NotificationApi,
  type NotificationEnvironment,
} from "../adapter/browser-desktop-notifications.js";

const desktopChrome =
  "Mozilla/5.0 (X11; Linux x86_64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/141.0.0.0 Safari/537.36";

/** A Notifications API that records requests and created notifications. */
function notificationApi(
  permission: NotificationPermission = "default",
  result: NotificationPermission = "granted",
) {
  const created: {
    title: string;
    options: NotificationOptions | undefined;
    instance: { onclick: (() => void) | null; closed: boolean };
  }[] = [];
  const api = {
    permission,
    requests: 0,
    failRequest: false,
    failConstruction: false,
    async requestPermission() {
      api.requests++;
      if (api.failRequest) throw new Error("Not allowed in this context");
      api.permission = result;
      return result;
    },
  };
  /** Stand in for the Notification constructor. */
  function FakeNotification(title: string, options?: NotificationOptions) {
    if (api.failConstruction) throw new TypeError("Illegal constructor");
    const instance = {
      onclick: null as (() => void) | null,
      closed: false,
      close() {
        instance.closed = true;
      },
    };
    created.push({ title, options, instance });
    return instance;
  }
  Object.defineProperty(FakeNotification, "permission", {
    get: () => api.permission,
  });
  (
    FakeNotification as unknown as { requestPermission: unknown }
  ).requestPermission = api.requestPermission;
  return {
    api,
    created,
    constructor: FakeNotification as unknown as NotificationApi,
  };
}

/** A browser described by its API, device, and context. */
function environment(
  overrides: Partial<NotificationEnvironment> & {
    userAgent?: string;
    maxTouchPoints?: number;
    mobile?: boolean;
    coarse?: boolean;
  } = {},
): NotificationEnvironment & { events: EventTarget } {
  return {
    Notification: overrides.Notification,
    navigator: {
      userAgent: overrides.userAgent ?? desktopChrome,
      maxTouchPoints: overrides.maxTouchPoints ?? 0,
      ...(overrides.mobile === undefined
        ? {}
        : { userAgentData: { mobile: overrides.mobile } }),
      ...(overrides.navigator?.permissions
        ? { permissions: overrides.navigator.permissions }
        : {}),
    },
    isSecureContext: overrides.isSecureContext ?? true,
    matchMedia: () => ({ matches: overrides.coarse ?? false }),
    events: new EventTarget(),
  };
}

test("desktop browsers report the Notifications API's permission", () => {
  for (const permission of ["default", "denied", "granted"] as const) {
    const { constructor } = notificationApi(permission);
    assert.equal(
      new BrowserDesktopNotifications(
        environment({ Notification: constructor }),
      ).permission(),
      permission,
    );
  }
});

test("browsers without the API, insecure pages, phones, and tablets are unsupported and never asked", async () => {
  const unsupported = [
    environment({ Notification: undefined }),
    environment({
      Notification: notificationApi().constructor,
      isSecureContext: false,
    }),
    environment({
      Notification: notificationApi().constructor,
      userAgent:
        "Mozilla/5.0 (Linux; Android 15; Pixel 9) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/141.0.0.0 Mobile Safari/537.36",
    }),
    environment({
      Notification: notificationApi().constructor,
      userAgent:
        "Mozilla/5.0 (iPhone; CPU iPhone OS 18_0 like Mac OS X) AppleWebKit/605.1.15 (KHTML, like Gecko) Version/18.0 Mobile/15E148 Safari/604.1",
    }),
    // iPads report a desktop Safari user agent.
    environment({
      Notification: notificationApi().constructor,
      userAgent:
        "Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/605.1.15 (KHTML, like Gecko) Version/18.0 Safari/605.1.15",
      maxTouchPoints: 5,
    }),
    environment({ Notification: notificationApi().constructor, mobile: true }),
    environment({ Notification: notificationApi().constructor, coarse: true }),
  ];
  for (const browser of unsupported) {
    const notifications = new BrowserDesktopNotifications(browser);
    assert.equal(notifications.permission(), "unsupported");
    assert.equal(await notifications.requestPermission(), "unsupported");
    assert.throws(() =>
      notifications.show({
        title: "Avery",
        body: "Ready",
        tag: "t",
        onClick: () => undefined,
      }),
    );
  }
  const phone = notificationApi();
  await new BrowserDesktopNotifications(
    environment({ Notification: phone.constructor, mobile: true }),
  ).requestPermission();
  assert.equal(phone.api.requests, 0);
});

test("asking reports the browser's answer, and a refused request is passed to the caller", async () => {
  const granted = notificationApi("default", "granted");
  assert.equal(
    await new BrowserDesktopNotifications(
      environment({ Notification: granted.constructor }),
    ).requestPermission(),
    "granted",
  );
  const dismissed = notificationApi("default", "default");
  assert.equal(
    await new BrowserDesktopNotifications(
      environment({ Notification: dismissed.constructor }),
    ).requestPermission(),
    "default",
  );
  const failing = notificationApi();
  failing.api.failRequest = true;
  await assert.rejects(
    new BrowserDesktopNotifications(
      environment({ Notification: failing.constructor }),
    ).requestPermission(),
  );
});

test("showing creates a plain-text notification whose click runs its action and closes it", () => {
  const { constructor, created } = notificationApi("granted");
  const notifications = new BrowserDesktopNotifications(
    environment({ Notification: constructor }),
  );
  let clicks = 0;
  const shown = notifications.show({
    title: "Avery",
    body: "The plan is ready",
    tag: "everything-message-m1",
    icon: "/teammate-avatars/avatar-03.webp",
    onClick: () => clicks++,
  });
  assert.equal(created.length, 1);
  assert.equal(created[0]?.title, "Avery");
  assert.deepEqual(created[0]?.options, {
    body: "The plan is ready",
    tag: "everything-message-m1",
    icon: "/teammate-avatars/avatar-03.webp",
  });
  created[0]?.instance.onclick?.();
  assert.equal(clicks, 1);
  assert.equal(created[0]?.instance.closed, true);
  shown.close();
});

test("showing without permission, or when the browser refuses to create one, throws", () => {
  const blocked = notificationApi("denied");
  assert.throws(() =>
    new BrowserDesktopNotifications(
      environment({ Notification: blocked.constructor }),
    ).show({ title: "Avery", body: "", tag: "t", onClick: () => undefined }),
  );
  const refusing = notificationApi("granted");
  refusing.api.failConstruction = true;
  assert.throws(
    () =>
      new BrowserDesktopNotifications(
        environment({ Notification: refusing.constructor }),
      ).show({ title: "Avery", body: "", tag: "t", onClick: () => undefined }),
    TypeError,
  );
});

test("permission changes and returning to the window notify subscribers until they unsubscribe", async () => {
  const status = new EventTarget();
  const browser = environment({
    Notification: notificationApi().constructor,
    navigator: {
      userAgent: desktopChrome,
      maxTouchPoints: 0,
      permissions: {
        query: async () => status as PermissionStatus,
      },
    },
  });
  const notifications = new BrowserDesktopNotifications(browser);
  let changes = 0;
  const stop = notifications.subscribe(() => changes++);
  await Promise.resolve();
  await Promise.resolve();
  status.dispatchEvent(new Event("change"));
  browser.events.dispatchEvent(new Event("focus"));
  assert.equal(changes, 2);
  stop();
  status.dispatchEvent(new Event("change"));
  browser.events.dispatchEvent(new Event("focus"));
  assert.equal(changes, 2);
});
