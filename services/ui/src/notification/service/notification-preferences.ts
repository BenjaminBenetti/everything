import { browserStorage, type StorageAccess } from "./browser-storage.js";

const storagePrefix = "everything-desktop-notifications:";
const changeEvent = "everything-desktop-notifications-change";

/**
 * Each signed-in user's desktop notification choice on this device, off until they turn it on.
 * Saved like the color theme, in browser storage, and kept in sync across this browser's tabs.
 * A choice that couldn't be saved, because storage is unavailable, full, or read-only, still
 * applies on this page until it closes or another tab saves a newer choice.
 */
export class NotificationPreferences {
  // ===========================================
  // Construction
  // ===========================================
  /** Choices made on this page that storage refused, by user. */
  private readonly unsaved = new Map<string, boolean>();

  /** Use the browser's storage and window events unless a test supplies its own. */
  constructor(
    private readonly storage: StorageAccess = browserStorage,
    private readonly events: EventTarget = window,
  ) {}

  // ===========================================
  // Preference
  // ===========================================

  /** Whether this user turned desktop notifications on for this device. */
  enabled(subject: string): boolean {
    const unsaved = this.unsaved.get(subject);
    if (unsaved !== undefined) return unsaved;
    try {
      return this.storage()?.getItem(storagePrefix + subject) === "on";
    } catch {
      return false;
    }
  }

  /** Save the choice, keeping it for this page if storage refuses, and tell every control on this page. */
  setEnabled(subject: string, enabled: boolean): void {
    if (this.save(subject, enabled)) this.unsaved.delete(subject);
    else this.unsaved.set(subject, enabled);
    this.events.dispatchEvent(new Event(changeEvent));
  }

  /** Follow changes made on this page or in another tab; returns an unsubscribe function. */
  subscribe(listener: () => void): () => void {
    /** A choice saved in another tab, or cleared storage, replaces one this page couldn't save. */
    const restore = (event: Event) => {
      const key = (event as StorageEvent).key;
      if (key === null) this.unsaved.clear();
      else if (key?.startsWith(storagePrefix))
        this.unsaved.delete(key.slice(storagePrefix.length));
      else return;
      listener();
    };
    this.events.addEventListener(changeEvent, listener);
    this.events.addEventListener("storage", restore);
    return () => {
      this.events.removeEventListener(changeEvent, listener);
      this.events.removeEventListener("storage", restore);
    };
  }

  /** Write the choice, reporting whether storage accepted it. */
  private save(subject: string, enabled: boolean): boolean {
    try {
      const storage = this.storage();
      if (!storage) return false;
      if (enabled) storage.setItem(storagePrefix + subject, "on");
      else storage.removeItem(storagePrefix + subject);
      return true;
    } catch {
      return false;
    }
  }
}
