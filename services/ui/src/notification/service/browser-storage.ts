/** Browser storage, which can be missing or throw in private windows and locked-down browsers. */
export type StorageAccess = () => Storage | undefined;

/** Read `localStorage` without letting a blocked storage area throw. */
export function browserStorage(): Storage | undefined {
  try {
    return window.localStorage;
  } catch {
    return undefined;
  }
}
