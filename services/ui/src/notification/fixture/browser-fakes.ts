import type {
  DesktopNotificationContent,
  DesktopNotificationPermission,
  DesktopNotifications,
} from "../interface/desktop-notifications.js";
import type { ClaimLocks } from "../service/notification-claims.js";

/** Browser storage held in memory, which can refuse reads or writes like a locked-down browser. */
export class MemoryStorage implements Storage {
  private readonly items = new Map<string, string>();
  failReads = false;
  failWrites = false;

  get length(): number {
    return this.items.size;
  }

  clear(): void {
    this.items.clear();
  }

  getItem(key: string): string | null {
    if (this.failReads) throw new Error("Storage is blocked");
    return this.items.get(key) ?? null;
  }

  key(index: number): string | null {
    return [...this.items.keys()][index] ?? null;
  }

  removeItem(key: string): void {
    if (this.failWrites) throw new Error("Storage is read-only");
    this.items.delete(key);
  }

  setItem(key: string, value: string): void {
    if (this.failWrites) throw new Error("Storage is full");
    this.items.set(key, value);
  }
}

/** A notification the fake showed, with whether it's still open. */
export interface FakeShownNotification {
  readonly content: DesktopNotificationContent;
  closed: boolean;
}

/** Desktop notifications that record what would appear on screen instead of showing it. */
export class FakeDesktopNotifications implements DesktopNotifications {
  currentPermission: DesktopNotificationPermission = "granted";
  failShowing = false;
  readonly shown: FakeShownNotification[] = [];
  requests = 0;

  permission(): DesktopNotificationPermission {
    return this.currentPermission;
  }

  async requestPermission(): Promise<DesktopNotificationPermission> {
    this.requests++;
    return this.currentPermission;
  }

  show(content: DesktopNotificationContent) {
    if (this.failShowing) throw new TypeError("Illegal constructor");
    const shown: FakeShownNotification = { content, closed: false };
    this.shown.push(shown);
    return {
      close: () => {
        shown.closed = true;
      },
    };
  }

  subscribe(): () => void {
    return () => undefined;
  }

  /** Click a shown notification as the user would; the browser then closes it. */
  click(index: number): void {
    const shown = this.shown[index]!;
    shown.content.onClick();
    shown.closed = true;
  }
}

/** Exclusive locks like the Web Locks API, granted in request order across every holder. */
export function serialLocks(): ClaimLocks & { readonly names: string[] } {
  let tail: Promise<unknown> = Promise.resolve();
  const names: string[] = [];
  return {
    names,
    request: ((name: string, callback: () => unknown) => {
      names.push(name);
      const granted = tail.then(() => callback());
      tail = granted.catch(() => undefined);
      return granted;
    }) as ClaimLocks["request"],
  };
}

/** Let pending promise callbacks run. */
export async function settle(): Promise<void> {
  for (let turn = 0; turn < 10; turn++) await Promise.resolve();
}
